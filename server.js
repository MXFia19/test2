const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const path = require('path');

app.use(cors());
app.use(express.json());

const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// ORDRE DE TRI (Du meilleur au pire)
const QUALITY_ORDER = [
    'chunked',   // Source
    'source',
    '1080p60',
    '1080p30',
    '720p60',
    '720p30',
    '480p30',
    '360p30',
    '160p30',
    'audio_only'
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

// --- FONCTIONS ---
async function getChannelVideos(login) {
    const data = {
        query: `query {
            user(login: "${login}") {
                videos(first: 20, type: ARCHIVE, sort: TIME) {
                    edges {
                        node {
                            id
                            title
                            publishedAt
                            lengthSeconds
                            previewThumbnailURL(height: 180, width: 320)
                            viewCount
                        }
                    }
                }
            }
        }`
    };

    try {
        const response = await axios.post('https://gql.twitch.tv/gql', data, { headers: { 'Client-ID': CLIENT_ID } });
        if (!response.data.data.user) return null;
        return response.data.data.user.videos.edges.map(edge => edge.node);
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

async function getVodStoryboardData(vodId) {
    const data = {
        query: `query { video(id: "${vodId}") { seekPreviewsURL, owner { login } } }`
    };
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
        console.log(`⚡ Scan des qualités sur ${domain}...`);

        const promises = QUALITY_ORDER.map(async (q) => {
            const url = `https://${domain}/${vodSpecialID}/${q}/index-dvr.m3u8`;
            if (await checkLink(url)) {
                unsortedLinks[q] = url;
            }
        });

        await Promise.all(promises);

        let sortedLinks = {};
        for (const quality of QUALITY_ORDER) {
            if (unsortedLinks[quality]) {
                sortedLinks[quality] = unsortedLinks[quality];
            }
        }
        if (Object.keys(sortedLinks).length > 0) return sortedLinks;

    } catch (e) { console.log("Erreur:", e.message); }
    return null;
}

// Servir les fichiers statiques (CSS/JS/HTML)
app.use(express.static(path.join(__dirname, 'public')));

// --- PROXY CORS INTELLIGENT (Gère les m3u8 et les .ts) ---
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL manquante');

    // Headers pour se faire passer pour Twitch
    const twitchHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://www.twitch.tv/',
        'Origin': 'https://www.twitch.tv'
    };

    try {
        // CAS 1 : C'est un fichier Playlist (.m3u8)
        // On doit le télécharger en TEXTE, modifier les liens dedans, puis l'envoyer.
        if (targetUrl.includes('.m3u8')) {
            const response = await axios.get(targetUrl, { 
                headers: twitchHeaders,
                responseType: 'text' // Important : on veut manipuler le texte
            });

            // On trouve le dossier de base de la vidéo sur Twitch (ex: https://.../chunked/)
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
            
            // On parcourt le fichier ligne par ligne
            const newContent = response.data.split('\n').map(line => {
                const l = line.trim();
                // Si la ligne est vide ou commence par # (info technique), on la garde telle quelle
                if (!l || l.startsWith('#')) return l; 
                
                // Sinon, c'est un lien vers un segment vidéo (.ts) !
                // On reconstruit le lien complet vers Twitch
                const fullLink = l.startsWith('http') ? l : baseUrl + l;
                
                // ET ON L'ENROBE DANS NOTRE PROXY pour que le lecteur repasse par nous
                return `/api/proxy?url=${encodeURIComponent(fullLink)}`;
            }).join('\n');

            // On envoie le fichier modifié
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(newContent);
        }

        // CAS 2 : C'est un segment vidéo (.ts) ou autre
        // On fait juste "passe-plat" (Stream) sans rien toucher
        const response = await axios({
            url: targetUrl,
            method: 'GET',
            responseType: 'stream',
            headers: twitchHeaders
        });

        res.set('Access-Control-Allow-Origin', '*');
        res.set('Content-Type', response.headers['content-type']);
        response.data.pipe(res);

    } catch (e) {
        console.error("Erreur Proxy:", e.message);
        if (!res.headersSent) res.status(500).send('Erreur lors du proxy');
    }
});

// --- FONCTION CORRIGÉE (Minuscules + DeviceID) ---
async function getLiveAccessToken(login) {
    // 1. Force le pseudo en minuscules (INDISPENSABLE)
    const cleanLogin = login.toLowerCase();

    const data = {
        operationName: "PlaybackAccessToken_Template",
        query: "query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: \"web\", playerBackend: \"mediaplayer\", playerType: $playerType}) @include(if: $isLive) { value signature __typename } }",
        variables: { isLive: true, login: cleanLogin, isVod: false, vodID: "", playerType: "site" }
    };

    try {
        const response = await axios.post('https://gql.twitch.tv/gql', data, { 
            headers: { 
                'Client-ID': CLIENT_ID,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Referer': 'https://www.twitch.tv/',
                'Origin': 'https://www.twitch.tv',
                // Ajout d'un Device-ID aléatoire pour éviter le blocage
                'Device-ID': 'MkMq8a9' + Math.random().toString(36).substring(2, 15)
            } 
        });

        // Si Twitch renvoie une erreur explicite
        if (response.data.errors) {
            console.log(`[Erreur GQL] ${JSON.stringify(response.data.errors)}`);
            return null;
        }

        return response.data.data.streamPlaybackAccessToken;
    } catch (e) { 
        console.log("Erreur Token Live:", e.message);
        return null; 
    }
}
// --- AJOUT : ROUTE API POUR LE LIVE ---
app.get('/api/get-live', async (req, res) => {
    const channelName = req.query.name;
    if (!channelName) return res.status(400).json({ error: 'Nom de chaîne manquant' });
    
    // On nettoie le nom (minuscules + sans espaces)
    const cleanName = channelName.trim().toLowerCase();
    
    console.log(`\n🔴 Recherche LIVE : ${cleanName}`);

    const tokenData = await getLiveAccessToken(cleanName);
    
    // Si tokenData est null, c'est que le live est OFF ou introuvable
    if (!tokenData) {
        return res.status(404).json({ error: "Live introuvable (Offline ou Pseudo invalide)." });
    }

    const url = `https://usher.ttvnw.net/api/channel/hls/${cleanName}.m3u8?allow_source=true&allow_audio_only=true&allow_spectre=true&player=twitchweb&playlist_include_framerate=true&segment_preference=4&sig=${tokenData.signature}&token=${tokenData.value}`;

    return res.json({ 
        links: { "Auto (Live)": url }, 
        best: url 
    });
});

// --- ROUTES ---
app.get('/api/get-channel-videos', async (req, res) => {
    const channelName = req.query.name;
    if (!channelName) return res.status(400).json({ error: 'Nom de chaîne manquant' });
    console.log(`\n🔎 Recherche chaîne : ${channelName}`);
    const videos = await getChannelVideos(channelName);
    if (videos) {
        return res.json({ videos: videos });
    } else {
        return res.status(404).json({ error: "Chaîne introuvable ou aucune VOD." });
    }
});

app.get('/api/get-m3u8', async (req, res) => {
    const vodId = req.query.id;
    if (!vodId) return res.status(400).send('ID manquant');
    console.log(`\n🔎 Analyse VOD : ${vodId}`);

    const tokenData = await getAccessToken(vodId);
    if (tokenData) {
        const url = `https://usher.ttvnw.net/vod/${vodId}.m3u8?nauth=${tokenData.value}&nauthsig=${tokenData.signature}&allow_source=true&player_backend=mediaplayer`;
        try {
            const check = await axios.get(url, AXIOS_CONFIG);
            if (check.data && typeof check.data === 'string' && check.data.includes('#EXTM3U')) {
                return res.json({ links: { "Auto (Officiel)": url }, best: url });
            }
        } catch (e) {}
    }

    const metadata = await getVodStoryboardData(vodId);
    if (metadata && metadata.seekPreviewsURL) {
        const links = await storyboardHack(metadata.seekPreviewsURL);
        if (links) {
            const best = Object.values(links)[0];
            return res.json({ links: links, best: best, info: `VOD de ${metadata.owner.login}` });
        }
    }

    res.status(404).json({ error: "VOD introuvable." });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- PORT CONFIG POUR RENDER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur prêt sur le port ${PORT}`);
});





