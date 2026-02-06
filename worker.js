// worker.js - VERSION V13 (Live Économique - Liens Directs pour Segments)
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const COMMON_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cache-Control, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
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
            if (url.pathname === '/api/proxy') return await handleProxy(url, request, workerOrigin);
            
            if (url.pathname === '/') return new Response("Twitch Proxy V13 Eco Ready", { headers: COMMON_HEADERS });
            if (url.pathname === '/api/get-live') return await handleGetLive(url, workerOrigin);
            if (url.pathname === '/api/get-channel-videos') return await handleGetVideos(url);
            if (url.pathname === '/api/get-m3u8') return await handleGetM3U8(url, workerOrigin);
            
            return new Response("Not Found", { status: 404, headers: COMMON_HEADERS });
        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' } });
        }
    }
};

// --- CŒUR DU SYSTÈME ÉCONOMIQUE ---
async function handleProxy(url, request, workerOrigin) {
    const target = url.searchParams.get('url');
    if (!target) return new Response("URL manquante", { status: 400 });

    const isVod = url.searchParams.get('isVod') === 'true';

    // 1. On prépare la requête vers Twitch
    let fetchHeaders = { ...COMMON_HEADERS };
    if (request.headers.get("Range")) {
        fetchHeaders["Range"] = request.headers.get("Range");
    }

    const res = await fetch(target, { headers: fetchHeaders });

    // 2. Si c'est une Playlist (.m3u8), on doit la lire et la modifier
    if (target.includes('.m3u8')) {
        const newHeaders = new Headers(res.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Content-Type", "application/vnd.apple.mpegurl"); // Important pour iOS

        const text = await res.text();
        const finalUrl = res.url; 
        const base = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);

        const newText = text.split('\n').map(l => {
            const line = l.trim();
            if (!line || line.startsWith('#')) return line;
            const full = line.startsWith('http') ? line : base + line;
            
            // MAGIE V13 : 
            // - Si c'est une autre playlist (.m3u8), on passe par le proxy (pour continuer à naviguer)
            // - Si c'est un fichier vidéo (.ts), on donne le LIEN DIRECT (Économie de requêtes)
            if (line.includes('.m3u8')) {
                return `${workerOrigin}/api/proxy?url=${encodeURIComponent(full)}&isVod=${isVod}`;
            } else {
                return full; // Lien direct vers Twitch -> Pas de charge Cloudflare !
            }
        }).join('\n');

        return new Response(newText, { status: res.status, headers: newHeaders });
    }

    // Si on arrive ici (cas rare d'un fallback), on renvoie tel quel
    const fallbackHeaders = new Headers(res.headers);
    fallbackHeaders.set("Access-Control-Allow-Origin", "*");
    return new Response(res.body, { status: res.status, headers: fallbackHeaders });
}

// --- RESTE DU CODE (Similaire mais optimisé) ---

async function handleGetVideos(url) {
    const name = url.searchParams.get('name');
    if (!name) return jsonError("Nom manquant");
    const query = `query { user(login: "${name}") { profileImageURL(width: 70) videos(first: 20, type: ARCHIVE, sort: TIME) { edges { node { id, title, publishedAt, lengthSeconds, viewCount, previewThumbnailURL(height: 180, width: 320) } } } } }`;
    try {
        const data = await twitchGQL(query);
        const user = data.data.user;
        return jsonResponse({ videos: user.videos.edges.map(e => e.node), avatar: user.profileImageURL });
    } catch (e) { return jsonError(e.message, 500); }
}

async function handleGetLive(url, workerOrigin) {
    const name = url.searchParams.get('name');
    const login = name.trim().toLowerCase();
    try {
        const token = await getAccessToken(login, true);
        if (!token) return jsonError("Offline", 404);
        
        const masterUrl = `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8?allow_source=true&allow_audio_only=true&allow_spectre=true&player=twitchweb&sig=${token.signature}&token=${encodeURIComponent(token.value)}`;
        const res = await fetch(masterUrl, { headers: COMMON_HEADERS });
        
        // On force le proxy pour le master playlist (isVod=true est un flag interne ici pour dire "traite ça")
        const links = parseAndProxyM3U8(await res.text(), res.url, workerOrigin, true);
        
        const meta = await twitchGQL(`query { user(login: "${login}") { profileImageURL(width: 70) broadcastSettings { title game { displayName } } } }`);
        const manualThumbnail = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${login}-640x360.jpg`;
        
        return jsonResponse({ links, title: meta.data?.user?.broadcastSettings?.title || "Live", game: meta.data?.user?.broadcastSettings?.game?.displayName || "", thumbnail: manualThumbnail, avatar: meta.data?.user?.profileImageURL || "" });
    } catch (e) { return jsonError("Offline", 404); }
}

async function handleGetM3U8(url, workerOrigin) {
    const vodId = url.searchParams.get('id');
    try {
        const token = await getAccessToken(vodId, false);
        if (token) {
            const masterUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8?nauth=${token.value}&nauthsig=${token.signature}&allow_source=true&player_backend=mediaplayer`;
            const res = await fetch(masterUrl, { headers: COMMON_HEADERS });
            if (res.ok) {
                const links = parseAndProxyM3U8(await res.text(), res.url, workerOrigin, true);
                return jsonResponse({ links });
            }
        }
    } catch (e) {}
    
    // Backup Plan
    try {
        const data = await twitchGQL(`query { video(id: "${vodId}") { seekPreviewsURL } }`);
        if (data.data?.video?.seekPreviewsURL) {
           const links = await storyboardHack(data.data.video.seekPreviewsURL);
           let proxiedLinks = {};
           for(let k in links) proxiedLinks[k] = `${workerOrigin}/api/proxy?url=${encodeURIComponent(links[k])}&isVod=true`;
           return jsonResponse({ links: proxiedLinks });
        }
    } catch(e) {}
    return jsonError("VOD introuvable", 404);
}

// --- OUTILS ---
async function twitchGQL(query) {
    const res = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    return await res.json();
}
async function getAccessToken(id, isLive) {
    const query = isLive ? `query { streamPlaybackAccessToken(channelName: "${id}", params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }` : `query { videoPlaybackAccessToken(id: "${id}", params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"}) { value signature } }`;
    const data = await twitchGQL(query);
    return isLive ? data.data?.streamPlaybackAccessToken : data.data?.videoPlaybackAccessToken;
}
function parseAndProxyM3U8(content, master, workerOrigin, isVod) {
    const lines = content.split('\n');
    let links = {};
    lines.forEach(l => {
        if (l.includes('VIDEO="chunked"') || (l.startsWith('http') && !l.includes('VIDEO='))) {
             links["Source"] = `${workerOrigin}/api/proxy?url=${encodeURIComponent(l.startsWith('http') ? l : master)}&isVod=${isVod}`;
        }
    });
    if (Object.keys(links).length === 0) links["Source"] = `${workerOrigin}/api/proxy?url=${encodeURIComponent(master)}&isVod=${isVod}`;
    return links;
}
async function storyboardHack(seekUrl) {
    const root = seekUrl.replace(/\/storyboards\/.*$/, '');
    return { "Source": `${root}/chunked/index-dvr.m3u8` };
}

function jsonResponse(obj) { return new Response(JSON.stringify(obj), { headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' } }); }
function jsonError(msg, status) { return new Response(JSON.stringify({ error: msg }), { status, headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' } }); }