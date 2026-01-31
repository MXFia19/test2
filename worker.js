// worker.js - VERSION V9 (Miniature Manuelle + Titre Restauré + Proxy VOD)
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
        const workerOrigin = url.origin; 
        
        try {
            if (url.pathname === '/') return new Response("Twitch Proxy V9 Ready", { headers: COMMON_HEADERS });
            if (url.pathname === '/api/get-live') return await handleGetLive(url, workerOrigin);
            if (url.pathname === '/api/get-channel-videos') return await handleGetVideos(url);
            if (url.pathname === '/api/get-m3u8') return await handleGetM3U8(url, workerOrigin);
            if (url.pathname === '/api/proxy') return await handleProxy(url);

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

    // Requête simplifiée pour éviter les erreurs de syntaxe
    const query = `query { user(login: "${name}") { profileImageURL(width: 70) videos(first: 20, type: ARCHIVE, sort: TIME${cursor ? `, after: "${cursor}"` : ""}) { edges { node { id, title, publishedAt, lengthSeconds, viewCount, previewThumbnailURL(height: 180, width: 320) } } pageInfo { hasNextPage, endCursor } } } }`;
    
    try {
        const data = await twitchGQL(query);
        const user = data.data.user;
        if (!user || !user.videos) return jsonError("Aucune vidéo", 404);
        
        return jsonResponse({ 
            videos: user.videos.edges.map(e => e.node), 
            pagination: user.videos.pageInfo,
            avatar: user.profileImageURL
        });
    } catch (e) { return jsonError(e.message, 500); }
}

async function handleGetLive(url, workerOrigin) {
    const name = url.searchParams.get('name');
    if (!name) return jsonError("Nom manquant");
    const login = name.trim().toLowerCase();

    try {
        const token = await getAccessToken(login, true);
        if (!token) return jsonError("Offline", 404);

        const masterUrl = `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8?allow_source=true&allow_audio_only=true&allow_spectre=true&player=twitchweb&playlist_include_framerate=true&segment_preference=4&sig=${token.signature}&token=${encodeURIComponent(token.value)}`;
        
        const res = await fetch(masterUrl, { headers: COMMON_HEADERS });
        if (!res.ok) throw new Error("Stream introuvable");
        
        const links = parseAndProxyM3U8(await res.text(), res.url, workerOrigin, true);
        
        // CORRECTION : On sépare la requête metadata et on enlève le champ "stream" qui posait problème
        const metaQuery = `query { user(login: "${login}") { profileImageURL(width: 70) broadcastSettings { title game { displayName } } } }`;
        const meta = await twitchGQL(metaQuery);
        
        const info = meta.data?.user?.broadcastSettings;
        const avatar = meta.data?.user?.profileImageURL;

        // ASTUCE : On génère la miniature manuellement, c'est 100% fiable
        const manualThumbnail = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-640x360.jpg`;

        return jsonResponse({ 
            links, 
            best: links["Source"] || links["Auto"],
            title: info?.title || "Live", 
            game: info?.game?.displayName || "",
            thumbnail: manualThumbnail,
            avatar: avatar || "" 
        });
    } catch (e) { return jsonError(e.message, 404); }
}

async function handleGetM3U8(url, workerOrigin) {
    const vodId = url.searchParams.get('id');
    if (!vodId) return jsonError("ID manquant");

    // PLAN A
    try {
        const token = await getAccessToken(vodId, false);
        if (token) {
            const masterUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8?nauth=${token.value}&nauthsig=${token.signature}&allow_source=true&player_backend=mediaplayer`;
            const res = await fetch(masterUrl, { headers: COMMON_HEADERS });
            if (res.ok) {
                const links = parseAndProxyM3U8(await res.text(), res.url, workerOrigin, true);
                return jsonResponse({ links, best: links["Source"] || links["Auto"] });
            }
        }
    } catch (e) {}

    // PLAN B
    try {
        const data = await twitchGQL(`query { video(id: "${vodId}") { seekPreviewsURL } }`);
        const seekUrl = data.data?.video?.seekPreviewsURL;
        
        if (seekUrl) {
            const rawLinks = await storyboardHack(seekUrl);
            if (Object.keys(rawLinks).length > 0) {
                let proxiedLinks = {};
                const displayOrder = ['Source', '1080p60', '1080p30', '720p60', '720p30', '480p30', '360p30', '160p30', 'audio_only'];
                proxiedLinks["Auto"] = `${workerOrigin}/api/proxy?url=${encodeURIComponent(Object.values(rawLinks)[0])}&isVod=true`;

                displayOrder.forEach(key => {
                    Object.keys(rawLinks).forEach(k => {
                        if (k.toLowerCase().includes(key.toLowerCase())) {
                            proxiedLinks[k] = `${workerOrigin}/api/proxy?url=${encodeURIComponent(rawLinks[k])}&isVod=true`;
                            delete rawLinks[k];
                        }
                    });
                });
                return jsonResponse({ links: proxiedLinks, best: proxiedLinks["Source"] || proxiedLinks["Auto"], info: "Mode Backup Active" });
            }
        }
    } catch (e) {}

    return jsonError("VOD introuvable ou protégée", 404);
}

async function handleProxy(url) {
    const target = url.searchParams.get('url');
    if (!target) return new Response("URL manquante", { status: 400 });

    const isVod = url.searchParams.get('isVod') === 'true';
    const workerOrigin = url.origin;

    const res = await fetch(target, { headers: COMMON_HEADERS });

    if (target.includes('.m3u8')) {
        const text = await res.text();
        const finalUrl = res.url; 
        const base = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);

        const newText = text.split('\n').map(l => {
            const line = l.trim();
            if (!line || line.startsWith('#')) return line;
            const full = line.startsWith('http') ? line : base + line;
            if (line.includes('.m3u8') || isVod) {
                return `${workerOrigin}/api/proxy?url=${encodeURIComponent(full)}&isVod=${isVod}`;
            }
            return full; 
        }).join('\n');
        return new Response(newText, { status: res.status, headers: { ...COMMON_HEADERS, 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    return new Response(res.body, { status: res.status, headers: { ...COMMON_HEADERS, 'Content-Type': 'video/MP2T' } });
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
    if (!res.ok) throw new Error(`GQL ${res.status}`);
    return await res.json();
}

async function getAccessToken(id, isLive) {
    const query = isLive 
        ? `query { streamPlaybackAccessToken(channelName: "${id}", params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }`
        : `query { videoPlaybackAccessToken(id: "${id}", params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }`;
    
    const data = await twitchGQL(query);
    return isLive ? data.data?.streamPlaybackAccessToken : data.data?.videoPlaybackAccessToken;
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
        return found;
    } catch(e) { return {}; }
}

function parseAndProxyM3U8(content, master, workerOrigin, isVod) {
    const lines = content.split('\n');
    const proxyBase = `${workerOrigin}/api/proxy?url=`;
    let unsorted = {};
    let last = "";
    lines.forEach(l => {
        if (l.includes('VIDEO="')) {
            try { let n = l.split('VIDEO="')[1].split('"')[0]; if (n === 'chunked') n = 'Source'; last = n; } catch(e) {}
        } else if (l.startsWith('http') && last) {
            unsorted[last] = `${proxyBase}${encodeURIComponent(l)}&isVod=${isVod}`; last = "";
        }
    });
    let sorted = {};
    sorted["Auto"] = `${proxyBase}${encodeURIComponent(master)}&isVod=${isVod}`;
    const displayOrder = ['Source', '1080p60', '1080p30', '720p60', '720p30', '480p30', '360p30', '160p30', 'audio_only'];
    displayOrder.forEach(key => { Object.keys(unsorted).forEach(k => { if (k.toLowerCase().includes(key.toLowerCase())) { sorted[k] = unsorted[k]; delete unsorted[k]; } }); });
    Object.assign(sorted, unsorted);
    return sorted;
}

function jsonResponse(obj) { return new Response(JSON.stringify(obj), { headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' } }); }
function jsonError(msg, status) { return new Response(JSON.stringify({ error: msg }), { status, headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' } }); }
