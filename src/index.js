require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Webex = require('webex-node');

const app = express();
const PORT = process.env.PORT || 3000;

// Static access token (backward-compatible). Mutable so the refresh loop can rotate it.
let WEBEX_ACCESS_TOKEN = process.env.WEBEX_ACCESS_TOKEN || '';
// OAuth2 refresh-token grant credentials. If provided, the service exchanges them
// for a fresh access token on startup and rotates the access token before it expires.
const WEBEX_CLIENT_ID = process.env.WEBEX_CLIENT_ID || '';
const WEBEX_CLIENT_SECRET = process.env.WEBEX_CLIENT_SECRET || '';
let WEBEX_REFRESH_TOKEN = process.env.WEBEX_REFRESH_TOKEN || '';

const WEBEX_BOT_TOKEN = process.env.WEBEX_BOT_TOKEN;
const WEBEX_ROOM_ID = process.env.WEBEX_ROOM_ID || process.env.WEBEX_ROON_ID;
const WEBEX_WEBHOOK_SECRET = process.env.WEBEX_WEBHOOK_SECRET || '';

const LIST_URL = 'https://webexapis.com/v1/admin/convergedRecordings';
const DETAILS_URL = 'https://webexapis.com/v1/convergedRecordings';
const MESSAGES_URL = 'https://webexapis.com/v1/messages';
const PEOPLE_URL = 'https://webexapis.com/v1/people';
const TOKEN_URL = 'https://webexapis.com/v1/access_token';

// Refresh the access token this many seconds before it actually expires.
const TOKEN_REFRESH_LEAD_SECONDS = 5 * 60;
// On failed refresh, retry no sooner than this.
const TOKEN_REFRESH_MIN_SECONDS = 60;
// Cap the wait between refreshes (defensive; Webex tokens typically last 12h).
const TOKEN_REFRESH_MAX_SECONDS = 11 * 60 * 60;
let tokenRefreshTimer = null;

const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || 10);
const LINK_READY_MAX_RETRIES = Number(process.env.LINK_READY_MAX_RETRIES || 20);
const LINK_READY_RETRY_SECONDS = Number(process.env.LINK_READY_RETRY_SECONDS || 10);
const MAX_TRACKED_RECORDINGS = 5000;

const RECORDING_STORAGE_DIR = process.env.RECORDING_STORAGE_DIR === ''
    ? null
    : path.resolve(process.env.RECORDING_STORAGE_DIR || './recordings');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 95 * 1024 * 1024);

const processedRecordings = new Set();
const personByEmailCache = new Map();
const MAX_PERSON_CACHE_ENTRIES = 1000;
let isFirstRun = true;

const REQUEST_KEYWORD = 'request';
const REQUEST_COUNT_MIN = 1;
const REQUEST_COUNT_MAX = 25;
const REQUEST_COUNT_DEFAULT = 5;
const REQUEST_COOLDOWN_MS = 10_000;
const lastRequestByPerson = new Map();
const MAX_RATE_LIMIT_ENTRIES = 1000;

let botPersonId = null;
let botDisplayName = null;
let botEmail = null;

function assertEnv() {
    const missing = [];
    if (!WEBEX_BOT_TOKEN) missing.push('WEBEX_BOT_TOKEN');
    if (!WEBEX_ROOM_ID) missing.push('WEBEX_ROOM_ID');

    const hasStaticToken = !!WEBEX_ACCESS_TOKEN;
    const hasRefreshCreds = !!(WEBEX_CLIENT_ID && WEBEX_CLIENT_SECRET && WEBEX_REFRESH_TOKEN);
    if (!hasStaticToken && !hasRefreshCreds) {
        missing.push('WEBEX_ACCESS_TOKEN  OR  (WEBEX_CLIENT_ID + WEBEX_CLIENT_SECRET + WEBEX_REFRESH_TOKEN)');
    }

    if (missing.length) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
}

function hasRefreshCredentials() {
    return !!(WEBEX_CLIENT_ID && WEBEX_CLIENT_SECRET && WEBEX_REFRESH_TOKEN);
}

async function refreshAccessToken() {
    if (!hasRefreshCredentials()) {
        return { ok: false, reason: 'missing refresh credentials' };
    }
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: WEBEX_CLIENT_ID,
        client_secret: WEBEX_CLIENT_SECRET,
        refresh_token: WEBEX_REFRESH_TOKEN
    });

    try {
        const r = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            },
            body: body.toString()
        });

        if (!r.ok) {
            const errText = await r.text().catch(() => '');
            console.error(`Access token refresh failed: HTTP ${r.status} ${r.statusText} - ${errText.slice(0, 300)}`);
            return { ok: false, reason: `HTTP ${r.status}` };
        }

        const data = await r.json();
        if (!data.access_token) {
            console.error('Access token refresh returned no access_token in response.');
            return { ok: false, reason: 'no access_token in response' };
        }

        WEBEX_ACCESS_TOKEN = data.access_token;
        const expiresIn = Number(data.expires_in) || (12 * 60 * 60);

        if (data.refresh_token && data.refresh_token !== WEBEX_REFRESH_TOKEN) {
            console.warn('[Token rotation] Webex returned a NEW refresh_token. Update WEBEX_REFRESH_TOKEN in .env to keep working after the next restart.');
            WEBEX_REFRESH_TOKEN = data.refresh_token;
        }

        console.log(`Access token refreshed; expires in ~${Math.floor(expiresIn / 60)} min.`);
        scheduleNextTokenRefresh(expiresIn);
        return { ok: true, expiresIn };
    } catch (e) {
        console.error('Access token refresh error:', e.message);
        return { ok: false, reason: e.message };
    }
}

function scheduleNextTokenRefresh(expiresInSeconds) {
    if (tokenRefreshTimer) {
        clearTimeout(tokenRefreshTimer);
        tokenRefreshTimer = null;
    }
    let nextSeconds = expiresInSeconds - TOKEN_REFRESH_LEAD_SECONDS;
    if (!Number.isFinite(nextSeconds) || nextSeconds < TOKEN_REFRESH_MIN_SECONDS) {
        nextSeconds = TOKEN_REFRESH_MIN_SECONDS;
    }
    if (nextSeconds > TOKEN_REFRESH_MAX_SECONDS) {
        nextSeconds = TOKEN_REFRESH_MAX_SECONDS;
    }
    tokenRefreshTimer = setTimeout(async () => {
        const result = await refreshAccessToken();
        if (!result.ok) {
            // Refresh failed; back off and try again in a minute.
            scheduleNextTokenRefresh(TOKEN_REFRESH_LEAD_SECONDS + TOKEN_REFRESH_MIN_SECONDS);
        }
    }, nextSeconds * 1000);
    if (typeof tokenRefreshTimer.unref === 'function') tokenRefreshTimer.unref();
    console.log(`Next access token refresh scheduled in ~${Math.floor(nextSeconds / 60)} min.`);
}

function sleep(seconds) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

function rememberRecording(id) {
    if (!id) return;
    processedRecordings.add(id);
    if (processedRecordings.size > MAX_TRACKED_RECORDINGS) {
        const overflow = processedRecordings.size - MAX_TRACKED_RECORDINGS;
        const iterator = processedRecordings.values();
        for (let i = 0; i < overflow; i++) {
            processedRecordings.delete(iterator.next().value);
        }
    }
}

function formatDateToEST(isoDateString) {
    if (!isoDateString) return 'N/A';
    try {
        const date = new Date(isoDateString);
        return date.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        }) + ' EST';
    } catch (e) {
        return isoDateString;
    }
}

function formatDurationSeconds(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return 'N/A';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const parts = [];
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

function buildRecordingMessage(recording, links, { queueName, agentName, agentEmail, attachedKind } = {}) {
    const topic = recording.topic || 'Untitled Recording';
    const when = formatDateToEST(recording.timeRecorded);
    const duration = formatDurationSeconds(recording.durationSeconds);
    const ownerEmail = recording.ownerEmail || recording.hostEmail || '';
    const agent = agentName || agentEmail || ownerEmail || 'N/A';

    const lines = [];
    lines.push(`**New Webex Recording Available**`);
    lines.push('');
    lines.push(`**Topic:** ${topic}`);
    lines.push(`**Recorded:** ${when}`);
    lines.push(`**Duration:** ${duration}`);
    if (queueName) lines.push(`**Queue:** ${queueName}`);
    lines.push(`**Agent:** ${agent}`);
    if (recording.id) lines.push(`**Recording ID:** ${recording.id}`);
    lines.push('');

    if (attachedKind) {
        const label = attachedKind === 'audio' ? 'Audio' : (attachedKind === 'video' ? 'Video' : 'Recording');
        lines.push(`_${label} file is attached above and does not expire._`);
        if (links && links.transcriptDownloadLink) {
            lines.push('');
            lines.push(`**Transcript (temporary link):** [Download](${links.transcriptDownloadLink})`);
            if (links.expiration) {
                lines.push(`_Transcript link expires at ${formatDateToEST(links.expiration)}._`);
            }
        }
    } else {
        lines.push(`**Download Links (temporary):**`);
        const hasAny = links && (links.recordingDownloadLink || links.audioDownloadLink || links.transcriptDownloadLink);
        if (!hasAny) {
            lines.push('- _No download links were published with this recording._');
        } else {
            if (links.recordingDownloadLink) lines.push(`- [Video](${links.recordingDownloadLink})`);
            if (links.audioDownloadLink) lines.push(`- [Audio](${links.audioDownloadLink})`);
            if (links.transcriptDownloadLink) lines.push(`- [Transcript](${links.transcriptDownloadLink})`);
            if (links.expiration) {
                lines.push('');
                lines.push(`_Links expire at ${formatDateToEST(links.expiration)}._`);
            }
        }
    }

    return lines.join('\n');
}

async function postToWebexRoom(markdown, attachment = null) {
    try {
        let body;
        const headers = { 'Authorization': `Bearer ${WEBEX_BOT_TOKEN}` };

        if (attachment && attachment.buffer && attachment.filename) {
            const fd = new FormData();
            fd.append('roomId', WEBEX_ROOM_ID);
            fd.append('markdown', markdown);
            const blob = new Blob([attachment.buffer], { type: attachment.contentType || 'application/octet-stream' });
            fd.append('files', blob, attachment.filename);
            body = fd;
            // fetch + FormData sets multipart Content-Type with the proper boundary; do not set it manually.
        } else {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify({ roomId: WEBEX_ROOM_ID, markdown });
        }

        const result = await fetch(MESSAGES_URL, { method: 'POST', headers, body });

        if (!result.ok) {
            const errBody = await result.text().catch(() => '');
            throw new Error(`HTTP ${result.status} ${result.statusText} - ${errBody.slice(0, 200)}`);
        }

        if (attachment) {
            console.log(`  Posted recording to Webex space with attachment (${attachment.filename}, ${attachment.buffer.length} bytes).`);
        } else {
            console.log('  Posted recording links to Webex space.');
        }
        return true;
    } catch (error) {
        console.error('Error posting to Webex room:', error.message);
        return false;
    }
}

function safeFilenameSegment(s) {
    return String(s || '')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^[._-]+|[._-]+$/g, '')
        .slice(0, 80) || 'recording';
}

function extensionFromUrl(url, fallback) {
    try {
        const u = new URL(url);
        const m = u.pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
        if (m) return m[1].toLowerCase();
    } catch (e) {
        // ignore
    }
    return fallback;
}

async function downloadRecordingFile(downloadUrl) {
    if (!downloadUrl) return null;
    try {
        const response = await fetch(downloadUrl, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${WEBEX_ACCESS_TOKEN}` },
            redirect: 'follow'
        });
        if (!response.ok) {
            console.error(`  Recording download failed: HTTP ${response.status} ${response.statusText}`);
            return null;
        }
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared && declared > MAX_UPLOAD_BYTES) {
            console.warn(`  Recording size ${declared} bytes exceeds MAX_UPLOAD_BYTES (${MAX_UPLOAD_BYTES}); skipping download.`);
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length > MAX_UPLOAD_BYTES) {
            console.warn(`  Recording size ${buffer.length} bytes exceeds MAX_UPLOAD_BYTES (${MAX_UPLOAD_BYTES}); discarding.`);
            return null;
        }
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        return { buffer, contentType };
    } catch (error) {
        console.error('  Error downloading recording file:', error.message);
        return null;
    }
}

async function saveRecordingToDisk(buffer, recordingId, ext) {
    if (!RECORDING_STORAGE_DIR) return null;
    try {
        await fs.promises.mkdir(RECORDING_STORAGE_DIR, { recursive: true });
        const safeId = safeFilenameSegment(recordingId);
        const safeExt = safeFilenameSegment(ext) || 'bin';
        const finalPath = path.join(RECORDING_STORAGE_DIR, `${safeId}.${safeExt}`);
        // Defense against any path-traversal weirdness in recordingId.
        const resolved = path.resolve(finalPath);
        if (!resolved.startsWith(path.resolve(RECORDING_STORAGE_DIR) + path.sep) && resolved !== path.resolve(RECORDING_STORAGE_DIR)) {
            console.warn('  Refusing to write recording outside storage dir:', resolved);
            return null;
        }
        const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
        await fs.promises.writeFile(tmpPath, buffer);
        await fs.promises.rename(tmpPath, finalPath);
        console.log(`  Saved recording to disk: ${finalPath} (${buffer.length} bytes)`);
        return finalPath;
    } catch (error) {
        console.error('  Error saving recording to disk:', error.message);
        return null;
    }
}

async function getRecordingDetails(recordingId) {
    try {
        const response = await fetch(`${DETAILS_URL}/${encodeURIComponent(recordingId)}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${WEBEX_ACCESS_TOKEN}`,
                'Accept': 'application/json;charset=UTF-8'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const details = await response.json();
        console.log('\n' + '-'.repeat(60));
        console.log(`RECORDING API RESPONSE (details) for ${recordingId} @ ${new Date().toISOString()}`);
        console.log('-'.repeat(60));
        console.log(JSON.stringify(details, null, 2));
        console.log('-'.repeat(60));
        return details;
    } catch (error) {
        console.error(`Error fetching recording details for ${recordingId}:`, error.message);
        return null;
    }
}

async function getRecordingMetadata(recordingId) {
    try {
        const response = await fetch(`${DETAILS_URL}/${encodeURIComponent(recordingId)}/metadata`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${WEBEX_ACCESS_TOKEN}`,
                'Accept': 'application/json;charset=UTF-8'
            }
        });

        if (!response.ok) {
            const bodySnippet = await response.text().catch(() => '');
            console.warn(`  Recording metadata fetch returned HTTP ${response.status} ${response.statusText} for ${recordingId}${bodySnippet ? ` - ${bodySnippet.slice(0, 200)}` : ''}`);
            return null;
        }

        const metadata = await response.json();
        console.log('\n' + '-'.repeat(60));
        console.log(`RECORDING API RESPONSE (metadata) for ${recordingId} @ ${new Date().toISOString()}`);
        console.log('-'.repeat(60));
        console.log(JSON.stringify(metadata, null, 2));
        console.log('-'.repeat(60));
        return metadata;
    } catch (error) {
        console.error(`Error fetching recording metadata for ${recordingId}:`, error.message);
        return null;
    }
}

async function getPersonByEmail(email) {
    if (!email) return null;
    if (!WEBEX_ACCESS_TOKEN) {
        return null;
    }
    const key = email.toLowerCase();
    if (personByEmailCache.has(key)) {
        return personByEmailCache.get(key);
    }
    try {
        const url = `${PEOPLE_URL}?email=${encodeURIComponent(email)}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${WEBEX_ACCESS_TOKEN}`,
                'Accept': 'application/json'
            },
            redirect: 'follow'
        });

        if (!response.ok) {
            console.warn(`  People lookup failed for ${email}: HTTP ${response.status} ${response.statusText}`);
            return null;
        }

        const data = await response.json();
        const person = Array.isArray(data.items) && data.items.length ? data.items[0] : null;
        const displayName = person && (person.displayName || (person.firstName && person.lastName ? `${person.firstName} ${person.lastName}` : person.firstName || person.lastName));
        const result = displayName || null;

        if (personByEmailCache.size >= MAX_PERSON_CACHE_ENTRIES) {
            const firstKey = personByEmailCache.keys().next().value;
            personByEmailCache.delete(firstKey);
        }
        personByEmailCache.set(key, result);
        return result;
    } catch (error) {
        console.warn(`  People lookup error for ${email}:`, error.message);
        return null;
    }
}

let webexBot = null;

async function startWebexBotListeners() {
    try {
        webexBot = Webex.init({ credentials: { access_token: WEBEX_BOT_TOKEN } });
    } catch (err) {
        console.error('Failed to initialize Webex SDK:', err.message);
        return;
    }

    try {
        const me = await webexBot.people.get('me');
        botPersonId = me.id || null;
        botDisplayName = me.displayName || me.nickName || '';
        botEmail = (Array.isArray(me.emails) && me.emails[0]) || '';
        console.log(`Bot identity: ${botDisplayName} <${botEmail}> (${botPersonId})`);
    } catch (err) {
        console.warn('Could not load bot identity via SDK:', err.message);
    }

    try {
        await webexBot.messages.listen();
        console.log('Listening for @mentions over WebSocket...');
        webexBot.messages.on('created', async (event) => {
            try {
                await handleIncomingMessage(event);
            } catch (e) {
                console.error('Error in messages listener:', e.message);
            }
        });
    } catch (err) {
        console.error('Could not start messages listener:', err.message);
    }

    try {
        await webexBot.attachmentActions.listen();
        console.log('Listening for adaptive-card submissions over WebSocket...');
        webexBot.attachmentActions.on('created', async (event) => {
            try {
                await handleIncomingCardAction(event);
            } catch (e) {
                console.error('Error in attachmentActions listener:', e.message);
            }
        });
    } catch (err) {
        console.error('Could not start attachmentActions listener:', err.message);
    }
}

async function handleIncomingMessage(event) {
    const data = (event && event.data) || event || {};
    if (!data || !data.id) return;
    if (data.roomId !== WEBEX_ROOM_ID) {
        return;
    }
    const senderId = data.personId || event.actorId;
    if (botPersonId && senderId === botPersonId) return;
    if (botPersonId && Array.isArray(data.mentionedPeople) && !data.mentionedPeople.includes(botPersonId)) {
        return;
    }

    const text = stripBotMentionFromText(data.text || '', botDisplayName);
    const lower = text.toLowerCase();
    const matchesRequest = new RegExp(`(^|\\W)${REQUEST_KEYWORD}($|\\W)`, 'i').test(lower);

    if (matchesRequest) {
        if (!rateLimitOk(senderId, 'mention')) {
            console.log(`Rate limit hit for ${senderId} on mention; ignoring 'request'.`);
            return;
        }
        console.log(`Mention matched 'request' from ${data.personEmail || senderId}; sending card.`);
        await postAdaptiveCardToRoom(buildRequestCountCard(), 'How many recent recordings would you like to see?');
    } else {
        console.log('Mention did not match keyword; sending help reply.');
        const name = botDisplayName ? `@${botDisplayName} ` : '';
        await postPlainMessageToRoom(`Hi! Try \`${name}${REQUEST_KEYWORD}\` to fetch recent recordings.`);
    }
}

async function handleIncomingCardAction(event) {
    const data = (event && event.data) || event || {};
    if (!data) return;
    if (data.roomId !== WEBEX_ROOM_ID) {
        return;
    }
    const submitterId = data.personId || event.actorId;
    if (botPersonId && submitterId === botPersonId) return;
    if (data.type && data.type !== 'submit') return;

    const inputs = data.inputs || {};
    const requested = Math.floor(Number(inputs.count));
    const count = Number.isFinite(requested)
        ? Math.max(REQUEST_COUNT_MIN, Math.min(REQUEST_COUNT_MAX, requested))
        : REQUEST_COUNT_DEFAULT;

    if (!rateLimitOk(submitterId, 'submit')) {
        console.log(`Rate limit hit for ${submitterId} on card submit; ignoring.`);
        return;
    }

    console.log(`Card submit from ${submitterId}; fetching last ${count} recording(s).`);
    await respondWithRecentRecordings(count);
}

async function postPlainMessageToRoom(markdown) {
    try {
        const r = await fetch(MESSAGES_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${WEBEX_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomId: WEBEX_ROOM_ID, markdown })
        });
        if (!r.ok) {
            const t = await r.text().catch(() => '');
            console.error(`Plain message post failed: HTTP ${r.status} ${r.statusText} ${t.slice(0, 200)}`);
            return false;
        }
        return true;
    } catch (e) {
        console.error('Plain message post error:', e.message);
        return false;
    }
}

function buildRequestCountCard() {
    return {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.3',
        body: [
            {
                type: 'TextBlock',
                text: 'How many recent recordings would you like to see?',
                weight: 'Bolder',
                wrap: true
            },
            {
                type: 'Input.Number',
                id: 'count',
                min: REQUEST_COUNT_MIN,
                max: REQUEST_COUNT_MAX,
                value: REQUEST_COUNT_DEFAULT,
                label: `Number of recordings (${REQUEST_COUNT_MIN}\u2013${REQUEST_COUNT_MAX})`
            }
        ],
        actions: [
            {
                type: 'Action.Submit',
                title: 'Show recordings',
                data: { action: 'showRecordings' }
            }
        ]
    };
}

async function postAdaptiveCardToRoom(card, fallbackText) {
    try {
        const r = await fetch(MESSAGES_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${WEBEX_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                roomId: WEBEX_ROOM_ID,
                markdown: fallbackText || 'How many recordings would you like?',
                attachments: [{
                    contentType: 'application/vnd.microsoft.card.adaptive',
                    content: card
                }]
            })
        });
        if (!r.ok) {
            const t = await r.text().catch(() => '');
            console.error(`Card post failed: HTTP ${r.status} ${r.statusText} ${t.slice(0, 200)}`);
            return false;
        }
        return true;
    } catch (e) {
        console.error('Card post error:', e.message);
        return false;
    }
}

function stripBotMentionFromText(text, botName) {
    if (!text) return '';
    let s = String(text);
    if (botName) {
        const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        s = s.replace(new RegExp(`^\\s*${escaped}\\b\\s*`, 'i'), '');
        s = s.replace(new RegExp(`\\s*${escaped}\\b\\s*$`, 'i'), '');
    }
    return s.trim();
}

function rateLimitOk(personId, bucket = 'default') {
    if (!personId) return true;
    const key = `${bucket}:${personId}`;
    const now = Date.now();
    const last = lastRequestByPerson.get(key);
    if (last && now - last < REQUEST_COOLDOWN_MS) return false;
    lastRequestByPerson.set(key, now);
    if (lastRequestByPerson.size > MAX_RATE_LIMIT_ENTRIES) {
        const firstKey = lastRequestByPerson.keys().next().value;
        lastRequestByPerson.delete(firstKey);
    }
    return true;
}

async function fetchRecentRecordings(limit) {
    try {
        const r = await fetch(LIST_URL, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${WEBEX_ACCESS_TOKEN}`, 'Accept': 'application/json;charset=UTF-8' }
        });
        if (!r.ok) {
            throw new Error(`HTTP ${r.status} ${r.statusText}`);
        }
        const data = await r.json();
        const items = Array.isArray(data.items) ? data.items.slice() : [];
        items.sort((a, b) => {
            const ta = new Date(a.timeRecorded || a.createTime || 0).getTime();
            const tb = new Date(b.timeRecorded || b.createTime || 0).getTime();
            return tb - ta;
        });
        return items.slice(0, limit);
    } catch (e) {
        console.error('fetchRecentRecordings error:', e.message);
        return [];
    }
}

async function findRecordingOnDisk(recordingId) {
    if (!RECORDING_STORAGE_DIR) return null;
    try {
        const safeId = safeFilenameSegment(recordingId);
        const files = await fs.promises.readdir(RECORDING_STORAGE_DIR);
        const match = files.find(f => f.startsWith(safeId + '.'));
        if (!match) return null;
        const ext = match.slice(safeId.length + 1).toLowerCase();
        const contentTypeByExt = { mp3: 'audio/mpeg', mp4: 'video/mp4', m4a: 'audio/mp4', wav: 'audio/wav', vtt: 'text/vtt' };
        return {
            path: path.join(RECORDING_STORAGE_DIR, match),
            ext,
            contentType: contentTypeByExt[ext] || 'application/octet-stream'
        };
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn('Could not read storage dir:', e.message);
        return null;
    }
}

async function postSingleRecordingFromHistory(recording) {
    const id = recording && recording.id;
    if (!id) return;

    let merged = { ...recording };
    const metadata = await getRecordingMetadata(id);
    if (metadata) {
        const mergedServiceData = { ...(merged.serviceData || {}), ...(metadata.serviceData || {}) };
        merged = { ...merged, ...metadata, serviceData: mergedServiceData };
    }

    const ownerType = (merged.ownerType || '').toUpperCase();
    const queueName = ownerType === 'CALL_QUEUE' ? (merged.ownerName || null) : null;
    const managedBy = merged.serviceData && merged.serviceData.managedBy;
    const agentName = managedBy && managedBy.name ? managedBy.name : null;
    const agentEmail = managedBy && managedBy.actor && managedBy.actor.email ? managedBy.actor.email : null;

    let attachment = null;
    let attachedKind = null;

    const onDisk = await findRecordingOnDisk(id);
    if (onDisk) {
        try {
            const buffer = await fs.promises.readFile(onDisk.path);
            if (buffer.length > MAX_UPLOAD_BYTES) {
                console.warn(`  ${id}: on-disk file ${buffer.length} bytes exceeds MAX_UPLOAD_BYTES; skipping attachment.`);
            } else {
                const topicSeg = safeFilenameSegment(merged.topic || id);
                attachment = {
                    buffer,
                    contentType: onDisk.contentType,
                    filename: `${topicSeg}.${safeFilenameSegment(onDisk.ext) || 'bin'}`
                };
                attachedKind = onDisk.ext === 'mp3' || onDisk.ext === 'm4a' || onDisk.ext === 'wav' ? 'audio'
                    : (onDisk.ext === 'mp4' ? 'video' : 'recording');
            }
        } catch (e) {
            console.warn(`  ${id}: could not read on-disk file:`, e.message);
        }
    }

    const links = merged.temporaryDirectDownloadLinks || null;
    const message = buildRecordingMessage(merged, links, { queueName, agentName, agentEmail, attachedKind });
    const ok = await postToWebexRoom(message, attachment);
    if (!ok && attachment) {
        await postToWebexRoom(buildRecordingMessage(merged, links, { queueName, agentName, agentEmail }), null);
    }
}

async function respondWithRecentRecordings(count) {
    const safeCount = Math.max(REQUEST_COUNT_MIN, Math.min(REQUEST_COUNT_MAX, Math.floor(Number(count) || REQUEST_COUNT_DEFAULT)));
    const items = await fetchRecentRecordings(safeCount);
    if (items.length === 0) {
        await postPlainMessageToRoom('No recordings available yet.');
        return;
    }
    const header = items.length < safeCount
        ? `📂 Showing all ${items.length} available recording(s) (newest first):`
        : `📂 Showing the last ${items.length} recording(s) (newest first):`;
    await postPlainMessageToRoom(header);
    for (const recording of items) {
        await postSingleRecordingFromHistory(recording);
    }
}

async function waitForDownloadLinks(recordingId) {
    for (let attempt = 1; attempt <= LINK_READY_MAX_RETRIES; attempt++) {
        const details = await getRecordingDetails(recordingId);
        const links = details && details.temporaryDirectDownloadLinks;
        if (links && (links.recordingDownloadLink || links.audioDownloadLink || links.transcriptDownloadLink)) {
            return { details, links };
        }
        if (attempt < LINK_READY_MAX_RETRIES) {
            console.log(`  Download links not ready yet (attempt ${attempt}/${LINK_READY_MAX_RETRIES}). Retrying in ${LINK_READY_RETRY_SECONDS}s...`);
            await sleep(LINK_READY_RETRY_SECONDS);
        }
    }
    return { details: null, links: null };
}

async function handleNewRecording(recordingFromSource, { source }) {
    const id = recordingFromSource && recordingFromSource.id;
    if (!id) {
        console.warn('handleNewRecording called without recording id; skipping.');
        return;
    }

    console.log('\n' + '='.repeat(60));
    console.log(`NEW RECORDING DETECTED (via ${source})`);
    console.log('Timestamp:', new Date().toISOString());
    console.log('Recording ID:', id);
    console.log('='.repeat(60));

    let recording = recordingFromSource;
    let links = recordingFromSource.temporaryDirectDownloadLinks || null;

    if (!links || !(links.recordingDownloadLink || links.audioDownloadLink || links.transcriptDownloadLink)) {
        console.log('Fetching recording details to resolve download links...');
        const result = await waitForDownloadLinks(id);
        if (result.details) {
            recording = { ...recording, ...result.details };
        }
        links = result.links;
    }

    console.log('Fetching recording metadata for queue/agent details...');
    const metadata = await getRecordingMetadata(id);
    if (metadata) {
        const mergedServiceData = { ...(recording.serviceData || {}), ...(metadata.serviceData || {}) };
        recording = { ...recording, ...metadata, serviceData: mergedServiceData };
    }

    const ownerType = (recording.ownerType || '').toUpperCase();
    const queueName = ownerType === 'CALL_QUEUE' ? (recording.ownerName || null) : null;

    const managedBy = recording.serviceData && recording.serviceData.managedBy;
    let agentName = managedBy && managedBy.name ? managedBy.name : null;
    let agentEmail = managedBy && managedBy.actor && managedBy.actor.email ? managedBy.actor.email : null;

    if (queueName) {
        console.log(`  Queue: ${queueName}`);
    }
    if (agentName || agentEmail) {
        console.log(`  Agent: ${agentName || ''}${agentEmail ? ` <${agentEmail}>` : ''}`);
    }

    if (!agentName) {
        const ownerEmail = recording.ownerEmail || recording.hostEmail || agentEmail || '';
        if (ownerEmail) {
            const resolved = await getPersonByEmail(ownerEmail);
            if (resolved) {
                agentName = resolved;
                if (!agentEmail) agentEmail = ownerEmail;
                console.log(`  Resolved agent name for ${ownerEmail}: ${agentName}`);
            } else {
                if (!agentEmail) agentEmail = ownerEmail;
                console.log(`  Could not resolve display name for ${ownerEmail}; falling back to email.`);
            }
        }
    }

    let attachment = null;
    let attachedKind = null;

    if (links) {
        let primaryUrl = null;
        let primaryKind = null;
        let primaryFallbackExt = null;
        if (links.audioDownloadLink) {
            primaryUrl = links.audioDownloadLink;
            primaryKind = 'audio';
            primaryFallbackExt = (recording.format || 'mp3').toLowerCase();
        } else if (links.recordingDownloadLink) {
            primaryUrl = links.recordingDownloadLink;
            primaryKind = 'video';
            primaryFallbackExt = (recording.format || 'mp4').toLowerCase();
        }

        if (primaryUrl) {
            console.log(`  Downloading ${primaryKind} recording for storage and upload...`);
            const downloaded = await downloadRecordingFile(primaryUrl);
            if (downloaded) {
                const ext = extensionFromUrl(primaryUrl, primaryFallbackExt);
                await saveRecordingToDisk(downloaded.buffer, id, ext);
                const topicSeg = safeFilenameSegment(recording.topic || id);
                const displayFilename = `${topicSeg}.${safeFilenameSegment(ext) || (primaryKind === 'audio' ? 'mp3' : 'mp4')}`;
                attachment = {
                    buffer: downloaded.buffer,
                    contentType: downloaded.contentType,
                    filename: displayFilename
                };
                attachedKind = primaryKind;
            } else {
                console.warn('  Falling back to link-only message (download failed or file too large).');
            }
        }
    }

    const message = buildRecordingMessage(recording, links, { queueName, agentName, agentEmail, attachedKind });
    const posted = await postToWebexRoom(message, attachment);
    if (!posted && attachment) {
        console.warn('  Attachment post failed; retrying without attachment...');
        await postToWebexRoom(buildRecordingMessage(recording, links, { queueName, agentName, agentEmail }), null);
    }
}

async function fetchConvergedRecordings() {
    try {
        const response = await fetch(LIST_URL, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${WEBEX_ACCESS_TOKEN}`,
                'Accept': 'application/json;charset=UTF-8'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const recordings = Array.isArray(data.items) ? data.items : [];
        console.log('\n' + '-'.repeat(60));
        console.log(`RECORDING API RESPONSE (list) @ ${new Date().toISOString()} - ${recordings.length} item(s)`);
        console.log('-'.repeat(60));
        console.log(JSON.stringify(data, null, 2));
        console.log('-'.repeat(60));

        if (isFirstRun) {
            for (const recording of recordings) {
                rememberRecording(recording.id);
            }
            console.log(`Initialized with ${recordings.length} existing recording(s). Watching for new ones...`);
            isFirstRun = false;
            return;
        }

        for (const recording of recordings) {
            if (!recording.id || processedRecordings.has(recording.id)) continue;
            rememberRecording(recording.id);
            await handleNewRecording(recording, { source: 'poll' });
        }
    } catch (error) {
        console.error('Error fetching recordings:', error.message);
    }
}

function verifyWebhookSignature(req, rawBody) {
    if (!WEBEX_WEBHOOK_SECRET) return true;
    const signature = req.get('X-Spark-Signature');
    if (!signature) return false;
    const hmac = crypto.createHmac('sha1', WEBEX_WEBHOOK_SECRET);
    hmac.update(rawBody);
    const expected = hmac.digest('hex');
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
}

app.use('/webhook/converged-recording', express.raw({ type: '*/*', limit: '256kb' }));

app.post('/webhook/converged-recording', async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

    if (!verifyWebhookSignature(req, rawBody)) {
        console.warn('Webhook signature verification failed. Rejecting request.');
        return res.status(401).json({ status: 'invalid signature' });
    }

    let payload;
    try {
        payload = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch (err) {
        console.warn('Webhook body is not valid JSON.');
        return res.status(400).json({ status: 'invalid json' });
    }

    res.status(200).json({ status: 'received' });

    try {
        if (payload.resource !== 'convergedRecordings' || payload.event !== 'created') {
            console.log(`Ignoring webhook: resource=${payload.resource}, event=${payload.event}`);
            return;
        }
        const data = payload.data;
        const id = data && data.id;
        if (!id) {
            console.warn('Webhook payload missing data.id; ignoring.');
            return;
        }
        if (processedRecordings.has(id)) {
            console.log(`Webhook for recording ${id} already processed; ignoring.`);
            return;
        }
        rememberRecording(id);
        await handleNewRecording(data, { source: 'webhook' });
    } catch (err) {
        console.error('Error handling webhook payload:', err.message);
    }
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
    res.status(200).json({
        service: 'webex-recording-webhook',
        endpoints: {
            health: 'GET /health',
            recordingWebhook: 'POST /webhook/converged-recording'
        },
        websocketListeners: ['messages.created', 'attachmentActions.created'],
        pollIntervalSeconds: POLL_INTERVAL_SECONDS
    });
});

async function init() {
    assertEnv();

    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Recording webhook:    POST http://localhost:${PORT}/webhook/converged-recording`);
        console.log(`Health endpoint:      GET  http://localhost:${PORT}/health`);
    });

    console.log('\nWebex Recording Monitor started');
    console.log(`Polling every ${POLL_INTERVAL_SECONDS}s for new recordings...\n`);

    if (hasRefreshCredentials()) {
        console.log('OAuth refresh credentials detected; rotating access token at startup...');
        const result = await refreshAccessToken();
        if (!result.ok && !WEBEX_ACCESS_TOKEN) {
            console.error('Could not obtain an access token via refresh, and no static WEBEX_ACCESS_TOKEN fallback set. Exiting.');
            process.exit(1);
        }
        if (!result.ok) {
            console.warn('Refresh failed; continuing with the static WEBEX_ACCESS_TOKEN from .env. Will retry refresh shortly.');
            scheduleNextTokenRefresh(TOKEN_REFRESH_LEAD_SECONDS + TOKEN_REFRESH_MIN_SECONDS);
        }
    } else {
        console.log('No OAuth refresh credentials set; using static WEBEX_ACCESS_TOKEN from .env (will not auto-rotate).');
    }

    await startWebexBotListeners();
    await fetchConvergedRecordings();
    setInterval(fetchConvergedRecordings, POLL_INTERVAL_SECONDS * 1000);
}

init();
