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
