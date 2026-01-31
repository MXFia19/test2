// worker.js
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const QUALITY_ORDER = [
    'chunked', 'source', '1080p60', '1080p30', '720p60', '720p30', '480p30', '360p30', '160p30', 'audio_only'
];

const COMMON_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
};

export default {
    async fetch(request, env, ctx) {
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: COMMON_HEADERS });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            if (path === '/') return new Response("Twitch Proxy Worker Running", { headers: COMMON_HEADERS });
            if (path === '/api/get-live') return handleGetLive(url);
            if (path === '/api/get-channel-videos') return handleGetVideos(url);
            if (path === '/api/get-m3u8') return handleGetM3U8(url);
            if (path === '/api/proxy') return handleProxy(url, request);

            return new Response("Not Found", { status: 404, headers: COMMON_HEADERS });
        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: COMMON_HEADERS });
        }
    }
};

// --- LOGIQUE ---

async function handleGetVideos(url) {
    const channelName = url.searchParams.get('name');
    const cursor = url.searchParams.get('cursor');
    if (!channelName) return jsonError("Nom manquant");

    const afterParam = cursor ? `, after: "${cursor}"` : "";
    const query = `query {
        user(login: "${channelName}") {
            videos(first: 20, type: ARCHIVE, sort: TIME${afterParam}) {
                edges { node { id, title, publishedAt, lengthSeconds, viewCount, previewThumbnailURL(height: 180, width: 320) } }
                pageInfo { hasNextPage, endCursor }
            }
        }
    }`;

    const data = await twitchGQL(query);
    const videoData = data.data.user?.videos;
    
    if (!videoData) return jsonError("Aucune vidéo trouvée", 404);

    return jsonResponse({
        videos: videoData.edges.map(edge => edge.node),
        pagination: videoData.pageInfo
    });
}

async function handleGetLive(url) {
    const channelName = url.searchParams.get('name');
    if (!channelName) return jsonError("Nom manquant");
    const cleanName = channelName.trim().toLowerCase();

    const tokenData = await getLiveAccessToken(cleanName);
    if (!tokenData) return jsonError("Offline", 404);

    const masterUrl = `https://usher.ttvnw.net/api/channel/hls/${cleanName}.m3u8?allow_source=true&allow_audio_only=true&allow_spectre=true&player=twitchweb&playlist_include_framerate=true&segment_preference=4&sig=${tokenData.signature}&token=${encodeURIComponent(tokenData.value)}`;

    const response = await fetch(masterUrl, { headers: COMMON_HEADERS });
    const text = await response.text();
    const links = parseM3U8(text, masterUrl);

    const metaQuery = `query { user(login: "${cleanName}") { broadcastSettings { title, game { displayName } } } }`;
    const metaData = await twitchGQL(metaQuery);
    const info = metaData.data?.user?.broadcastSettings;

    return jsonResponse({
        links: links,
        best: masterUrl,
        title: info?.title || "Live",
        game: info?.game?.displayName || ""
    });
}

async function handleGetM3U8(url) {
    const vodId = url.searchParams.get('id');
    if (!vodId) return jsonError("ID manquant");

    const tokenData = await getVodAccessToken(vodId);
    if (tokenData) {
        const masterUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8?nauth=${tokenData.value}&nauthsig=${tokenData.signature}&allow_source=true&player_backend=mediaplayer`;
        const res = await fetch(masterUrl, { headers: COMMON_HEADERS });
        if (res.ok) {
            const text = await res.text();
            if (text.includes('#EXTM3U')) {
                return jsonResponse({ links: parseM3U8(text, masterUrl), best: masterUrl });
            }
        }
    }
    return jsonError("VOD introuvable ou Sub-only", 404);
}

async function handleProxy(url, request) {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return new Response("URL manquante", { status: 400 });

    const isVod = url.searchParams.get('isVod') === 'true' || targetUrl.includes('/vod/');
    const originUrl = new URL(request.url);
    const workerBase = `${originUrl.protocol}//${originUrl.host}/api/proxy`;

    if (targetUrl.includes('.m3u8')) {
        const response = await fetch(targetUrl, { headers: COMMON_HEADERS });
        let text = await response.text();
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

        const newText = text.split('\n').map(line => {
            const l = line.trim();
            if (!l || l.startsWith('#')) return l;
            const fullLink = l.startsWith('http') ? l : baseUrl + l;

            if (l.includes('.m3u8')) {
                return `${workerBase}?url=${encodeURIComponent(fullLink)}&isVod=${isVod}`;
            } else {
                if (isVod) return `${workerBase}?url=${encodeURIComponent(fullLink)}&isVod=true`;
                else return fullLink; 
            }
        }).join('\n');

        return new Response(newText, {
            headers: { ...COMMON_HEADERS, 'Content-Type': 'application/vnd.apple.mpegurl' }
        });
    }

    const response = await fetch(targetUrl, { headers: COMMON_HEADERS });
    return new Response(response.body, {
        headers: { ...COMMON_HEADERS, 'Content-Type': response.headers.get('Content-Type') || 'video/MP2T' }
    });
}

// --- HELPERS ---
async function twitchGQL(query, variables = {}) {
    const res = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables })
    });
    return await res.json();
}

async function getLiveAccessToken(login) {
    const query = `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature } }`;
    const data = await twitchGQL(query, { isLive: true, login, playerType: "site" });
    return data.data?.streamPlaybackAccessToken;
}

async function getVodAccessToken(vodId) {
    const query = `query PlaybackAccessToken_Template($vodID: ID!, $isVod: Boolean!, $playerType: String!) { videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature } }`;
    const data = await twitchGQL(query, { isLive: false, isVod: true, vodID, playerType: "site" });
    return data.data?.videoPlaybackAccessToken;
}

function parseM3U8(content, masterUrl) {
    const lines = content.split('\n');
    let unsorted = {};
    let lastInfo = "";
    lines.forEach(line => {
        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
            const nameMatch = line.match(/VIDEO="([^"]+)"/);
            let name = nameMatch ? nameMatch[1] : "Inconnue";
            if (resMatch) name += ` (${resMatch[1]})`;
            if (name.includes('chunked')) name = "Source (Best)";
            lastInfo = name;
        } else if (line.startsWith('http') && lastInfo) {
            unsorted[lastInfo] = line;
            lastInfo = "";
        }
    });
    let sorted = { "Auto": masterUrl };
    const order = ["Source", "1080p60", "1080p30", "1080p", "720p60", "720p30", "720p", "480p", "360p", "160p", "audio_only"];
    order.forEach(k => { Object.keys(unsorted).forEach(u => { if (u.toLowerCase().includes(k.toLowerCase())) { sorted[u] = unsorted[u]; delete unsorted[u]; } }); });
    Object.assign(sorted, unsorted);
    return sorted;
}

function jsonResponse(data) {
    return new Response(JSON.stringify(data), { headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' } });
}

function jsonError(msg, status = 400) {
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...COMMON_HEADERS, 'Content-Type': 'application/json' } });
}
