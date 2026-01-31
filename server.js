const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());

const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// Liste de priorité pour le tri des qualités
const QUALITY_ORDER = [
    'chunked', 'source', '1080p60', '1080p30', '720p60', '720p30', '480p30', '360p30', '160p30', 'audio_only'
];

const AXIOS_CONFIG = {
    timeout: 5000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://www.twitch.tv/',
        'Origin': 'https://www.twitch.tv'
    },
    validateStatus: status => status >= 200 && status < 500
};

// --- FONCTIONS UTILITAIRES ---

async function getChannelVideos(login, cursor = null) {
    const afterParam = cursor ? `, after: "${cursor}"` : "";
    const data = {
        query: `query {
            user(login: "${login}") {
                videos(first: 20, type: ARCHIVE, sort: TIME${afterParam}) {
                    edges {
                        node {
                            id, title, publishedAt, lengthSeconds, viewCount,
                            previewThumbnailURL(height: 180, width: 320)
                        }
                    }
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                }
            }
        }`
    };
    try {
        const response = await axios.post('https://gql.twitch.tv/gql', data, { headers: { 'Client-ID': CLIENT_ID } });
        const videoData = response.data.data.user?.videos;
        if (!videoData) return null;
        
        return {
            videos: videoData.edges.map(edge => edge.node),
            pagination: videoData.pageInfo
        };
    } catch (e) { return null; }
}

async function getAccessToken(vodId) {
    const data = {
        operationName: "PlaybackAccessToken_Template",
        query: "query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isLive) { value signature __typename } videoPlaybackAccessToken(id: $vodID, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isVod) { value signature __typename } }",
        variables: { isLive: false, login: "", isVod: true, vodID: vodId, playerType: "site" }
    };
    try {
        const response = await axios.post('https://gql.twitch.tv/gql', data, { headers: { 'Client-ID': CLIENT_ID } });
        return response.data.data.videoPlaybackAccessToken;
    } catch (e) { return null; }
}

async function getLiveAccessToken(login) {
    const cleanLogin = login.toLowerCase();
    const data = {
        operationName: "PlaybackAccessToken_Template",
        query: "query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isLive) { value signature __typename } }",
        variables: { isLive: true, login: cleanLogin, playerType: "site" }
    };
    try {
        const response = await axios.post('https://gql.twitch.tv/gql', data, { 
            headers: { 
                'Client-ID': CLIENT_ID,
                'User-Agent': AXIOS_CONFIG.headers['User-Agent'],
                'Referer': 'https://www.twitch.tv/',
                'Origin': 'https://www.twitch.tv',
                'Device-ID': 'MkMq8a9' + Math.random().toString(36).substring(2, 15)
            } 
        });
        if (response.data.errors) return null;
        return response.data.data.streamPlaybackAccessToken;
    } catch (e) { return null; }
}

async function getStreamMetadata(login) {
    const data = {
        query: `query { user(login: "${login}") { broadcastSettings { title, game { displayName } } } }`
    };
    try {
        const response = await axios.post('https://gql.twitch.tv/gql', data, { headers: { 'Client-ID': CLIENT_ID } });
        return response.data.data?.user?.broadcastSettings;
    } catch (e) { return null; }
}

async function getVodStoryboardData(vodId) {
    const data = { query: `query { video(id: "${vodId}") { seekPreviewsURL, owner { login } } }` };
    try {
        const response = await axios.post('https://gql.twitch.tv/gql', data, { headers: { 'Client-ID': CLIENT_ID } });
        return response.data.data.video;
    } catch (e) { return null; }
}

async function checkLink(url) {
    try {
        const res = await axios.head(url, AXIOS_CONFIG);
        return res.status === 200;
    } catch (e) { return false; }
}

async function storyboardHack(seekPreviewsURL) {
    if (!seekPreviewsURL) return null;
    try {
        const urlObj = new URL(seekPreviewsURL);
        const domain = urlObj.host;
        const paths = urlObj.pathname.split("/");
        const storyboardIndex = paths.findIndex(element => element.includes("storyboards"));
        if (storyboardIndex === -1) return null;
        const vodSpecialID = paths[storyboardIndex - 1];
        
        let unsortedLinks = {};
        await Promise.all(QUALITY_ORDER.map(async (q) => {
            const url = `https://${domain}/${vodSpecialID}/${q}/index-dvr.m3u8`;
            if (await checkLink(url)) unsortedLinks[q] = url;
        }));

        let sortedLinks = {};
        for (const quality of QUALITY_ORDER) {
            if (unsortedLinks[quality]) sortedLinks[quality] = unsortedLinks[quality];
        }
        return Object.keys(sortedLinks).length > 0 ? sortedLinks : null;
    } catch (e) { return null; }
}

// --- FONCTION DE PARSING AVEC TRI (C'EST ICI LA MODIFICATION IMPORTANTE) ---
function parseM3U8(content, masterUrl) {
    const lines = content.split('\n');
    let unsortedLinks = {};
    let lastInfo = "";

    // 1. Extraction brute
    lines.forEach(line => {
        if (line.startsWith('#EXT-X-STREAM-INF')) {
            const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
            const nameMatch = line.match(/VIDEO="([^"]+)"/);
            
            let qualityName = nameMatch ? nameMatch[1] : "Inconnue";
            if (resMatch) qualityName += ` (${resMatch[1]})`;
            
            // On renomme "chunked" en "Source" pour que ce soit plus joli
            if (qualityName.includes('chunked')) qualityName = "Source (Best)";
            
            lastInfo = qualityName;
        } else if (line.startsWith('http')) {
            if (lastInfo) { unsortedLinks[lastInfo] = line; lastInfo = ""; }
        }
    });

    // 2. Création de la liste triée
    let sortedLinks = { "Auto": masterUrl };
    
    // Ordre de priorité d'affichage
    const displayOrder = ["Source", "1080p60", "1080p30", "1080p", "720p60", "720p30", "720p", "480p", "360p", "160p", "audio_only"];

    // On parcourt notre ordre préféré et on cherche si la qualité existe
    displayOrder.forEach(keyPart => {
        Object.keys(unsortedLinks).forEach(k => {
            if (k.toLowerCase().includes(keyPart.toLowerCase())) {
                sortedLinks[k] = unsortedLinks[k];
                delete unsortedLinks[k]; // On l'enlève pour ne pas le remettre
            }
        });
    });

    // On ajoute tout ce qui reste (qualités non prévues)
    Object.assign(sortedLinks, unsortedLinks);

    return sortedLinks;
}

// --- ROUTES API ---

app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL manquante');

    try {
        // Optimisation bandwith : On ne proxy que les playlists (.m3u8), pas les segments (.ts)
        if (targetUrl.includes('.m3u8')) {
            const response = await axios.get(targetUrl, { headers: AXIOS_CONFIG.headers, responseType: 'text' });
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
            
            const newContent = response.data.split('\n').map(line => {
                const l = line.trim();
                if (!l || l.startsWith('#')) return l; 
                
                const fullLink = l.startsWith('http') ? l : baseUrl + l;

                // Si c'est un m3u8, on continue de passer par le proxy
                if (l.includes('.m3u8')) {
                    return `/api/proxy?url=${encodeURIComponent(fullLink)}`;
                } else {
                    // Si c'est un segment vidéo (.ts), on envoie le lien direct (économie de bande passante Vercel)
                    return fullLink; 
                }
            }).join('\n');

            res.set('Access-Control-Allow-Origin', '*');
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(newContent);
        }

        // Fallback pour les cas bizarres
        const response = await axios({
            url: targetUrl, method: 'GET', responseType: 'stream', headers: AXIOS_CONFIG.headers
        });
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Content-Type', response.headers['content-type']);
        response.data.pipe(res);

    } catch (e) {
        if (!res.headersSent) res.status(500).send('Erreur proxy');
    }
});

app.get('/api/get-channel-videos', async (req, res) => {
    const channelName = req.query.name;
    const cursor = req.query.cursor;
    if (!channelName) return res.status(400).json({ error: 'Nom manquant' });
    const result = await getChannelVideos(channelName, cursor);
    return result ? res.json(result) : res.status(404).json({ error: "Chaîne introuvable ou aucune VOD." });
});

app.get('/api/get-live', async (req, res) => {
    const channelName = req.query.name;
    if (!channelName) return res.status(400).json({ error: 'Nom manquant' });
    
    const cleanName = channelName.trim().toLowerCase();
    const tokenData = await getLiveAccessToken(cleanName);
    if (!tokenData) return res.status(404).json({ error: "Offline" });

    const metadata = await getStreamMetadata(cleanName);
    const masterUrl = `https://usher.ttvnw.net/api/channel/hls/${cleanName}.m3u8?allow_source=true&allow_audio_only=true&allow_spectre=true&player=twitchweb&playlist_include_framerate=true&segment_preference=4&sig=${encodeURIComponent(tokenData.signature)}&token=${encodeURIComponent(tokenData.value)}`;

    try {
        const response = await axios.get(masterUrl, { headers: AXIOS_CONFIG.headers });
        // Utilisation de la nouvelle fonction de tri ici
        const links = parseM3U8(response.data, masterUrl);
        return res.json({ 
            links: links, best: masterUrl, 
            title: metadata?.title || "Live", game: metadata?.game?.displayName || "" 
        });
    } catch (e) {
        return res.status(404).json({ error: "Le streamer est hors-ligne." });
    }
});

app.get('/api/get-m3u8', async (req, res) => {
    const vodId = req.query.id;
    if (!vodId) return res.status(400).send('ID manquant');
    
    const tokenData = await getAccessToken(vodId);
    if (tokenData) {
        const masterUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8?nauth=${tokenData.value}&nauthsig=${tokenData.signature}&allow_source=true&player_backend=mediaplayer`;
        try {
            const response = await axios.get(masterUrl, AXIOS_CONFIG);
            if (response.data && response.data.includes('#EXTM3U')) {
                // Utilisation de la nouvelle fonction de tri ici aussi
                const links = parseM3U8(response.data, masterUrl);
                return res.json({ links: links, best: masterUrl });
            }
        } catch (e) {}
    }

    const metadata = await getVodStoryboardData(vodId);
    if (metadata && metadata.seekPreviewsURL) {
        const links = await storyboardHack(metadata.seekPreviewsURL);
        if (links) {
            return res.json({ links: links, best: Object.values(links)[0], info: `VOD de ${metadata.owner.login} (Mode Backup)` });
        }
    }
    res.status(404).json({ error: "VOD introuvable." });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- EXPORT POUR VERCEL ---
module.exports = app;
