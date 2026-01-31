// worker.js - VERSION ULTIME (Anti-Crash + Force Proxy + Storyboard)
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const COMMON_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Referer': 'https://www.twitch.tv/',
    'Origin': 'https://www.twitch.tv'
};

const QUALITY_ORDER = ['chunked', 'source', '1080p60', '1080p30', '720p60', '720p30', '480p30', '360p30', '160p30', 'audio_only'];

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") return new Response(null, { headers: COMMON_HEADERS });

        const url = new URL(request.url);
        
        try {
            if (url.pathname === '/') return new Response("Twitch Proxy Worker OK", { headers: COMMON_HEADERS });
            if (url.pathname === '/api/get-live') return await handleGetLive(url);
            if (url.pathname === '/api/get-channel-videos') return await handleGetVideos(url);
            if (url.pathname === '/api/get-m3u8') return await handleGetM3U8(url);
            if (url.pathname === '/api/proxy') return await handleProxy(url, request);

            return new Response("Not Found", { status: 404, headers: COMMON_HEADERS });
        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' } });
        }
    }
};

// --- HANDLERS ---

async function handleGetVideos(url) {
    const name = url.searchParams.get('name');
    const cursor = url.searchParams.get('cursor');
    if (!name) return jsonError("Nom manquant");

    const query = `query { user(login: "${name}") { videos(first: 20, type: ARCHIVE, sort: TIME${cursor ? `, after: "${cursor}"` : ""}) { edges { node { id, title, publishedAt, lengthSeconds, viewCount, previewThumbnailURL(height: 180, width: 320) } } pageInfo { hasNextPage, endCursor } } } }`;
    
    try {
        const data = await twitchGQL(query);
        const videos = data.data.user?.videos;
        if (!videos) return jsonError("Aucune vidéo", 404);
        return jsonResponse({ videos: videos.edges.map(e => e.node), pagination: videos.pageInfo });
    } catch (e) { return jsonError(e.message, 500); }
}

async function handleGetLive(url) {
    const name = url.searchParams.get('name');
    if (!name) return jsonError("Nom manquant");
    const login = name.trim().toLowerCase();

    try {
        const token = await getAccessToken(login, true);
        if (!token) return jsonError("Offline", 404);

        const masterUrl = `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8?allow_source=true&allow_audio_only=true&allow_spectre=true&player=twitchweb&playlist_include_framerate=true&segment_preference=4&sig=${token.signature}&token=${encodeURIComponent(token.value)}`;
        const res = await fetch(masterUrl, { headers: COMMON_HEADERS });
        if (!res.ok) throw new Error("Stream introuvable");
        
        const links = parseM3U8(await res.text(), masterUrl);
        const meta = await twitchGQL(`query { user(login: "${login}") { broadcastSettings { title, game { displayName } } } }`);
        const info = meta.data?.user?.broadcastSettings;

        return jsonResponse({ links, best: masterUrl, title: info?.title || "Live", game: info?.game?.displayName || "" });
    } catch (e) { return jsonError(e.message, 404); }
}

async function handleGetM3U8(url) {
    const vodId = url.searchParams.get('id');
    if (!vodId) return jsonError("ID manquant");

    // --- PLAN A : Méthode Officielle ---
    try {
        const token = await getAccessToken(vodId, false);
        if (token) {
            const masterUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8?nauth=${token.value}&nauthsig=${token.signature}&allow_source=true&player_backend=mediaplayer`;
            const res = await fetch(masterUrl, { headers: COMMON_HEADERS });
            if (res.ok) {
                return jsonResponse({ links: parseM3U8(await res.text(), masterUrl), best: masterUrl });
            }
        }
    } catch (e) {
        // C'EST ICI LA CORRECTION : On ignore l'erreur 500/403 et on passe au Plan B
    }

    // --- PLAN B : Storyboard (Contournement Sub-only) ---
    try {
        const data = await twitchGQL(`query { video(id: "${vodId}") { seekPreviewsURL, owner { login } } }`);
        const seekUrl = data.data?.video?.seekPreviewsURL;
        
        if (seekUrl) {
            const links = await storyboardHack(seekUrl);
            if (Object.keys(links).length > 0) {
                const best = Object.values(links)[0];
                return jsonResponse({ links, best, info: "Mode Déblocage (Plan B)" });
            }
        }
    } catch (e) {}

    return jsonError("VOD introuvable ou impossible à débloquer", 404);
}

async function handleProxy(url, request) {
    const target = url.searchParams.get('url');
    if (!target) return new Response("URL manquante", { status: 400 });

    const isVod = url.searchParams.get('isVod') === 'true' || target.includes('/vod/');
    const workerUrl = new URL(request.url).origin + '/api/proxy';

    // 1. Si c'est une playlist (.m3u8)
    if (target.includes('.m3u8')) {
        const res = await fetch(target, { headers: COMMON_HEADERS });
        const text = await res.text();
        const base = target.substring(0, target.lastIndexOf('/') + 1);

        const newText = text.split('\n').map(l => {
            const line = l.trim();
            if (!line || line.startsWith('#')) return line;
            const full = line.startsWith('http') ? line : base + line;
            
            // CORRECTION CORS : On force le proxy pour les segments VOD
            if (line.includes('.m3u8') || isVod) {
                return `${workerUrl}?url=${encodeURIComponent(full)}&isVod=${isVod}`;
            }
            return full; 
        }).join('\n');

        return new Response(newText, { headers: { ...COMMON_HEADERS, 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }

    // 2. Si c'est un segment (.ts), on le proxy pour éviter l'erreur CORS rouge
    const res = await fetch(target, { headers: COMMON_HEADERS });
    return new Response(res.body, { headers: { ...COMMON_HEADERS, 'Content-Type': 'video/MP2T' } });
}

// --- OUTILS ---

async function twitchGQL(query, variables = {}) {
    const res = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
            'Client-ID': CLIENT_ID,
            'Content-Type': 'application/json',
            'User-Agent': COMMON_HEADERS['User-Agent'],
            'Device-ID': 'MkMq8a9' + Math.random().toString(36).substring(2, 15)
        },
        body: JSON.stringify({ query, variables })
    });
    // Si pas OK, on lance une erreur pour que le "catch" du Plan A s'active
    if (!res.ok) throw new Error(`GQL Error ${res.status}`);
    return await res.json();
}

async function getAccessToken(id, isLive) {
    const query = isLive 
        ? `query { streamPlaybackAccessToken(channelName: "${id}", params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }`
        : `query { videoPlaybackAccessToken(id: "${id}", params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }`;
    
    const data = await twitchGQL(query);
    return isLive ? data.data.streamPlaybackAccessToken : data.data.videoPlaybackAccessToken;
}

async function storyboardHack(seekUrl) {
    try {
        const parts = seekUrl.split('/');
        const storyIndex = parts.indexOf('storyboards');
        if (storyIndex === -1) return {};
        
        const hash = parts[storyIndex - 1]; 
        const root = `https://${new URL(seekUrl).host}/${hash}`;

        let found = {};
        await Promise.all(QUALITY_ORDER.map(async q => {
            const u = `${root}/${q}/index-dvr.m3u8`;
            const res = await fetch(u, { method: 'HEAD', headers: COMMON_HEADERS });
            if (res.status === 200) found[q] = u;
        }));
        
        let sorted = {};
        QUALITY_ORDER.forEach(q => { if(found[q]) sorted[q] = found[q]; });
        return sorted;
    } catch(e) { return {}; }
}

function parseM3U8(content, master) {
    const lines = content.split('\n');
    let links = { "Auto": master };
    let last = "";
    lines.forEach(l => {
        if (l.includes('VIDEO="')) {
            let n = l.match(/VIDEO="([^"]+)"/)[1];
            if (n === 'chunked') n = 'Source';
            last = n;
        } else if (l.startsWith('http') && last) {
            links[last] = l; last = "";
        }
    });
    return links;
}

function jsonResponse(obj) { return new Response(JSON.stringify(obj), { headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' } }); }
function jsonError(msg, status) { return new Response(JSON.stringify({ error: msg }), { status, headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' } }); }
