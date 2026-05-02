# Webex Customer Assist Recordings → Webex Space

A Node.js service that watches a Webex Calling **Customer Assist** call queue for new
recordings, automatically posts each recording (with the audio file attached) into a
configured Webex space, and lets supervisors fetch the last N recordings on demand
by `@`-mentioning the bot with the keyword `request`.

The audio file is stored locally and re-attached to the Webex message, so supervisors
can come back to the recording days or weeks later — even though the original Webex
download URLs expire after a few hours.

---

## Table of contents

1. [What it does (with example)](#what-it-does-with-example)
2. [Architecture at a glance](#architecture-at-a-glance)
3. [Prerequisites](#prerequisites)
4. [Step-by-step setup](#step-by-step-setup)
   - [1. Get the code and install dependencies](#1-get-the-code-and-install-dependencies)
   - [2. Create a Webex bot](#2-create-a-webex-bot)
   - [3. Create / configure a Webex service app](#3-create--configure-a-webex-service-app)
   - [4. Find the target Webex space (room) ID](#4-find-the-target-webex-space-room-id)
   - [5. Add the bot to the space](#5-add-the-bot-to-the-space)
   - [6. Configure environment variables](#6-configure-environment-variables)
   - [7. Start the service](#7-start-the-service)
   - [8. (Optional) Register the recording webhook](#8-optional-register-the-recording-webhook)
   - [9. Smoke test](#9-smoke-test)
5. [Using the bot](#using-the-bot)
6. [Configuration reference](#configuration-reference)
7. [How it works (deeper dive)](#how-it-works-deeper-dive)
8. [Operations & troubleshooting](#operations--troubleshooting)
9. [Security & data handling notes](#security--data-handling-notes)
10. [Project layout](#project-layout)

---

## What it does (with example)

When a Customer Assist call queue produces a new recording, the bot posts something like this into your Webex space — with the actual `.mp3` attached:

```
**New Webex Recording Available**

**Topic:** BCQTest-20260501 1438
**Recorded:** Friday, May 1, 2026 at 10:38 AM EST
**Duration:** 14s
**Queue:** BCQTest
**Agent:** Rajitha Kantheti
**Recording ID:** 55d0403e-4f64-4c06-bbb0-d88c98294e0e

_Audio file is attached above and does not expire._
```

Later, a supervisor can ask the bot for older recordings without scrolling. They mention the bot:

```
@BCG Supervisor Assist request
```

The bot replies with a small Adaptive Card asking how many recordings to show (1–25, default 5). When they submit, the bot posts a header followed by the most recent N recordings, each with the audio file attached.

---

## Architecture at a glance

```
                    ┌──────────────────────────────────────────┐
                    │             Webex Cloud                  │
                    │                                          │
       New rec ───► │  /admin/convergedRecordings              │
                    │  /convergedRecordings/{id}               │
                    │  /convergedRecordings/{id}/metadata      │
                    │  /people, /messages                      │
                    │  Mercury WebSocket (bot events)          │
                    └────────────┬─────────────┬───────────────┘
                                 │             │
                  REST (admin)   │             │ WebSocket (bot)
                                 │             │
                          ┌──────┴─────────────┴──────┐
                          │     This Node service     │
                          │                           │
                          │  • polls every 10s        │
                          │  • optional /webhook      │
                          │  • Mercury listener       │
                          │  • downloads & saves MP3  │
                          │  • re-attaches to Webex   │
                          └───────────┬───────────────┘
                                      │
                                      ▼
                              ./recordings/<id>.mp3
                              (local backup)
```

There are two completely independent flows that share helpers:

| Flow | Trigger | What happens |
|---|---|---|
| **Auto-post** | A new recording is detected (via 10s polling, or via the optional `convergedRecordings/created` webhook) | Service downloads the recording, saves it locally, posts it (with file attached) to the configured space. |
| **On-demand request** | A supervisor `@`-mentions the bot with `request` in the configured space | Service replies with an Adaptive Card; on submit, posts the last N recordings, re-attaching their audio files from the local backup. |

The on-demand flow uses the Webex Mercury **WebSocket** (via the [`webex-node`](https://www.npmjs.com/package/webex-node) SDK), so you do **not** need to register `messages` or `attachmentActions` webhooks. The service opens a long-lived outbound TLS connection to Webex at startup and Webex pushes events down it.

---

## Prerequisites

| Item | Why |
|---|---|
| **Node.js 20+** | The service uses native `fetch`, `FormData`, `Blob`, and `--watch`. |
| **A Webex Calling org with Customer Assist** | Source of the recordings. |
| **Admin access in that org** | Needed to issue a service-app token with `spark-admin:recordings_read`. |
| **A Webex bot** (free, anyone can create) | Posts messages, listens to mentions and card submissions. |
| **A Webex space** that the bot will post into | The supervisors' channel. |
| **A public URL** *(optional)* | Only required if you want the recording webhook for sub-second detection. Polling alone gets you ~10s detection without a public URL. |

---

## Step-by-step setup

### 1. Get the code and install dependencies

```powershell
git clone <this-repo-url> recording_extraction_to_space
cd recording_extraction_to_space
npm install
```

That installs `express`, `dotenv`, and `webex-node`. Confirm Node is 20+:

```powershell
node -v
```

### 2. Create a Webex bot

A bot in Webex is a special kind of identity that can be added to spaces, posts messages, and only sees messages directed at it (via @mention or DM).

1. Go to <https://developer.webex.com/my-apps>.
2. Click **Create a New App** → **Create a Bot**.
3. Pick a display name (e.g., `BCG Supervisor Assist`), bot username (e.g., `bcg-supervisor-assist@webex.bot`), and an icon.
4. Click **Add Bot**.
5. **Copy the bot's access token** — it's shown once. Treat it like a password. You'll put it in `.env` as `WEBEX_BOT_TOKEN`.

> **Note on bot scopes:** Webex bots have a fixed implicit permission set (read mentions, post messages, read submissions on cards they posted, read their own profile). There are no scope toggles to flip — the bot token works as-is for everything this service does on the bot side.

### 3. Create / configure a Webex service app

The service app is a separate identity used for the **admin** REST calls (listing recordings, fetching recording metadata, looking up people). It's *not* the bot.

1. Go to <https://developer.webex.com/my-apps>.
2. Click **Create a New App** → **Create a Service App**.
3. Add the following scopes:
   - `spark:recordings_read` — read recordings as a user.
   - `spark:kms` — required for any content stored in encrypted Webex services.
   - `spark:people_read` — resolve email → display name (used as a fallback for non-Customer-Assist recordings; Customer Assist responses already include the agent name).
   - `spark-admin:recordings_read` — list and read recordings org-wide.
   - `spark-admin:telephony_config_read` — read call queue / Calling configuration.
   - `spark-compliance:recordings_read` — compliance-officer read scope (extra coverage for restricted recordings).
4. Submit the service app for org-admin authorization (your org admin clicks "Authorize" in Control Hub → Apps & integrations).
5. Once authorized, complete the OAuth flow once to obtain a **refresh token** for the service app. From the developer portal you'll have:
   - `Client ID`
   - `Client Secret`
   - `Refresh Token` (long-lived, ~90 days)

   Paste these into `.env` as `WEBEX_CLIENT_ID`, `WEBEX_CLIENT_SECRET`, `WEBEX_REFRESH_TOKEN`. **The service exchanges them for a fresh access token at startup and rotates the token automatically every ~11 hours, so the bot keeps running indefinitely without manual token refreshes.**

> **Quick-start fallback:** if you'd rather skip the OAuth flow and just paste a static access token, you can — set `WEBEX_ACCESS_TOKEN` instead of the three OAuth values. The bot will work, but you'll need to restart with a fresh token every ~12 hours when the token expires. For any non-trivial deployment, use the refresh-token approach.

> **Why two identities (bot + service app)?** The bot token can post messages and listen to mentions but *cannot* read recordings org-wide. The service-app token has admin recordings scope but is not a chat identity. This service uses both for what each is good at.

### 4. Find the target Webex space (room) ID

In the Webex app, open the space the bot should post into. Then:

```powershell
$BotToken = "YOUR_BOT_TOKEN"
Invoke-RestMethod -Uri https://webexapis.com/v1/rooms `
  -Headers @{ Authorization = "Bearer $BotToken" } |
  Select-Object -ExpandProperty items |
  Format-Table id, title -AutoSize
```

Find your space in the list and copy its `id`. (You'll see only spaces the bot is already a member of — see step 5 if your space isn't listed.)

### 5. Add the bot to the space

In the Webex app, in the target space, click the people/`+` icon → **Add people** → type the bot's email (e.g., `bcg-supervisor-assist@webex.bot`) → invite. The bot needs to be a member to post messages and to receive `@`-mention events.

### 6. Configure environment variables

```powershell
Copy-Item .env.example .env
notepad .env
```

**Required** values — service-app credentials (recommended: OAuth refresh-token flow), plus bot token and room ID:

```ini
# --- Option A (recommended): OAuth refresh-token grant -------------------
# The service exchanges these for a fresh access token at startup and
# auto-rotates it every ~11 hours, so the bot never goes down.
WEBEX_CLIENT_ID=Cxxxxxxxxxxxxxxxxxxxxxxx
WEBEX_CLIENT_SECRET=...
WEBEX_REFRESH_TOKEN=eyJ...long.refresh.token...

# --- Option B (fallback): static access token --------------------------
# Use this only if you don't want to do the OAuth flow. The token will
# expire (~12h) and you'll have to manually replace it. You can leave
# it blank if Option A is set.
WEBEX_ACCESS_TOKEN=

# --- Bot identity (always required) ----------------------------------
WEBEX_BOT_TOKEN=YjVjZTFi...bot.token...

# --- Target Webex space -----------------------------------------------
WEBEX_ROOM_ID=Y2lzY29zcGFyazovL3VybjpURUFNOnVz...
```

Optional values (sensible defaults if you leave them off — see [configuration reference](#configuration-reference)):

```ini
# How often to poll for new recordings (default 10s)
POLL_INTERVAL_SECONDS=10

# Where to keep local copies of every recording (default ./recordings)
RECORDING_STORAGE_DIR=./recordings

# Webhook signing secret (only matters if you also use the optional recording webhook)
WEBEX_WEBHOOK_SECRET=
```

### 7. Start the service

```powershell
npm start
```

You should see, within a few seconds:

```
Webex Recording Monitor started
Polling every 10s for new recordings...
Server running on port 3000
Recording webhook:    POST http://localhost:3000/webhook/converged-recording
Health endpoint:      GET  http://localhost:3000/health
Bot identity: BCG Supervisor Assist <bcg-supervisor-assist@webex.bot> (Y2lzY29zcGFyazov...)
Listening for @mentions over WebSocket...
Listening for adaptive-card submissions over WebSocket...
RECORDING API RESPONSE (list) @ ... - N item(s)
{ ...JSON dump of existing recordings... }
Initialized with N existing recording(s). Watching for new ones...
```

If you see all of those lines (especially the two "Listening for ... over WebSocket..." lines), the bot is ready.

For development with auto-reload on file changes:

```powershell
npm run dev
```

> **Important:** only ever run **one** instance of the service per bot token at a time. If two instances are running, both will receive the same WebSocket events from Webex and will reply twice. See [troubleshooting](#operations--troubleshooting).

### 8. (Optional) Register the recording webhook

This is **only** needed if you want sub-second detection of new recordings instead of the default ~10-second polling. Without it, the poller still picks up new recordings on the next interval.

1. Expose your local port publicly (skip if you're already on a public host):
   ```powershell
   ngrok http 3000
   ```
   Copy the HTTPS URL (e.g., `https://3a4b-12-34-56-78.ngrok-free.app`).

2. Pick or generate a `WEBEX_WEBHOOK_SECRET`, put it in `.env`, and **restart** the service.

3. Register the webhook:

   ```powershell
   $BotToken     = "YOUR_BOT_TOKEN"
   $Secret       = "VALUE_FROM_DOTENV_WEBEX_WEBHOOK_SECRET"
   $PublicUrl    = "https://3a4b-12-34-56-78.ngrok-free.app"

   $body = @{
     name      = "RecordingBot - New Recordings"
     targetUrl = "$PublicUrl/webhook/converged-recording"
     resource  = "convergedRecordings"
     event     = "created"
     secret    = $Secret
   } | ConvertTo-Json

   Invoke-RestMethod -Method Post `
     -Uri https://webexapis.com/v1/webhooks `
     -Headers @{ Authorization = "Bearer $BotToken"; "Content-Type" = "application/json" } `
     -Body $body
   ```

To list / delete webhooks later:

```powershell
Invoke-RestMethod -Uri https://webexapis.com/v1/webhooks `
  -Headers @{ Authorization = "Bearer $BotToken" } |
  Select-Object -ExpandProperty items |
  Format-Table id, name, resource, event, targetUrl -AutoSize

# Delete:
Invoke-RestMethod -Method Delete `
  -Uri https://webexapis.com/v1/webhooks/<webhookIdHere> `
  -Headers @{ Authorization = "Bearer $BotToken" }
```

You **do not** need to register `messages` or `attachmentActions` webhooks — those events arrive over the Mercury WebSocket the service opens automatically.

### 9. Smoke test

**Auto-post test:** place a brief test call into the Customer Assist queue. Within ~10 seconds (or sub-second if you registered the webhook), you should see in the service logs:

```
============================================================
NEW RECORDING DETECTED (via poll)
Recording ID: <new-id>
============================================================
... (details and metadata API responses) ...
  Queue: <queue name>
  Agent: <agent name> <agent@example.com>
  Downloading audio recording for storage and upload...
  Saved recording to disk: ...recordings\<new-id>.mp3 (NN bytes)
  Posted recording to Webex space with attachment (...mp3, NN bytes).
```

…and the message + audio file appear in your Webex space.

**On-demand request test:** in the Webex space, type:

```
@BCG Supervisor Assist request
```

The bot replies with the Adaptive Card. Pick a number, click **Show recordings**. The bot posts a header followed by N per-recording messages, each with the audio attached.

---

## Using the bot

### Auto-post (passive)
Nothing for end-users to do. The bot posts every new Customer Assist recording into the space as soon as it's available.

### On-demand request (active)
Mention the bot with the keyword `request`:

| You type | Bot does |
|---|---|
| `@bot request` | Posts an Adaptive Card asking how many recordings (1–25, default 5). |
| `@bot REQUEST` | Same — match is case-insensitive. |
| `@bot please request the recordings` | Same — `request` is matched on word boundaries anywhere in the text. |
| `@bot hello` | Posts a one-line help reply. |

After picking a number and clicking **Show recordings**, the bot posts:
- One header message: `📂 Showing the last N recording(s) (newest first):`
- N per-recording messages, each with Topic / Queue / Agent / time / duration / Recording ID, and the audio file attached if it's available locally.

Per-person rate limits: 10 seconds between back-to-back `request` mentions, and 10 seconds between back-to-back card submits.

---

## Configuration reference

Edit `.env` (copy from `.env.example`):

### Service-app credentials

Provide **either** Option A (preferred) **or** Option B (or both — A wins, B is the fallback when a refresh fails).

| Variable | When required | Purpose |
|---|---|---|
| `WEBEX_CLIENT_ID` | Option A | Service app's OAuth client ID. |
| `WEBEX_CLIENT_SECRET` | Option A | Service app's OAuth client secret. |
| `WEBEX_REFRESH_TOKEN` | Option A | Long-lived (~90 day) refresh token from the service app's OAuth flow. The service exchanges this for a fresh access token at startup and **auto-rotates the access token every ~11 hours** so the service can run indefinitely. |
| `WEBEX_ACCESS_TOKEN` | Option B | Static service-app access token. Will expire (~12h); restart with a fresh value when it does. Used as a fallback if a refresh attempt fails when both A and B are set. |

Required scopes on the service app (any subset that covers your usage; the project assumes all six):

- `spark:recordings_read`
- `spark:kms`
- `spark:people_read`
- `spark-admin:recordings_read`
- `spark-admin:telephony_config_read`
- `spark-compliance:recordings_read`

### Bot + space + everything else

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `WEBEX_BOT_TOKEN` | yes | — | Bot access token. Used for: posting messages, opening the Mercury WebSocket, listening to mentions and card submissions. |
| `WEBEX_ROOM_ID` | yes | — | The Webex space (room) the bot will post into. |
| `WEBEX_WEBHOOK_SECRET` | no | empty (off) | If set, incoming `/webhook/converged-recording` requests are HMAC-SHA1 verified. **Set this** if you register the recording webhook. |
| `RECORDING_STORAGE_DIR` | no | `./recordings` | Where to save a local copy of every recording. Set to `""` to disable disk storage. |
| `MAX_UPLOAD_BYTES` | no | `99614720` (~95 MB) | Max attachment size. Recordings larger than this are not downloaded; the message falls back to the temp link. |
| `PORT` | no | `3000` | HTTP port for `/health` and the optional recording webhook. |
| `POLL_INTERVAL_SECONDS` | no | `10` | Polling interval for new recordings. |
| `LINK_READY_MAX_RETRIES` | no | `20` | How many times to re-fetch recording details waiting for download links to populate. |
| `LINK_READY_RETRY_SECONDS` | no | `10` | Delay between those retries. |

---

## How it works (deeper dive)

### Auto-post pipeline

1. Every `POLL_INTERVAL_SECONDS`, the service calls `GET /v1/admin/convergedRecordings`. On the very first poll, all current recordings are marked as "already seen" so the bot doesn't spam the space with old recordings on every restart.
2. When a recording ID it hasn't seen before appears, it calls:
   - `GET /v1/convergedRecordings/{id}` — fetches `temporaryDirectDownloadLinks` (retrying a few times if the links aren't published yet).
   - `GET /v1/convergedRecordings/{id}/metadata` — fetches Customer Assist–specific data (`ownerName`, `serviceData.managedBy`, `callingParty`, etc.).
3. With both responses merged, it extracts:
   - **Queue** from `ownerName` (when `ownerType` is `CALL_QUEUE`).
   - **Agent** from `serviceData.managedBy.name` (and email from `…managedBy.actor.email`).
4. It downloads the primary recording asset (audio MP3 for Customer Assist, video MP4 for meetings) using `WEBEX_ACCESS_TOKEN`.
5. Atomic-writes the bytes to `RECORDING_STORAGE_DIR/<recordingId>.<ext>`.
6. Posts a message into `WEBEX_ROOM_ID` via `POST /v1/messages` as multipart form-data, with the audio file attached. The bot token is used to post.

If the download fails or exceeds `MAX_UPLOAD_BYTES`, the service falls back to posting just the temp link (with the expiration noted) so you don't lose visibility on a recording.

### On-demand request pipeline

1. At startup, the service initializes the Webex SDK with the bot token and calls `webex.messages.listen()` and `webex.attachmentActions.listen()`. These open a single Mercury WebSocket and subscribe to bot-relevant events.
2. When someone `@`-mentions the bot in `WEBEX_ROOM_ID` with the word `request`, the service:
   - Filters out events from other rooms / from the bot itself.
   - Strips the bot's display name from the start of the text.
   - Word-boundary regex matches `request` (case-insensitive) → posts an Adaptive Card.
3. When the card is submitted:
   - The WebSocket event already carries the `inputs` (no extra REST round-trip).
   - `inputs.count` is **clamped server-side** to 1–25 regardless of what the client sends.
   - The service calls `GET /v1/admin/convergedRecordings`, sorts by `timeRecorded` descending, takes the top N.
   - For each, fetches metadata, looks up the local file in `RECORDING_STORAGE_DIR`, and posts a per-recording message with the audio re-attached. If the file isn't on disk, the message still posts with metadata only.

### Access token rotation

If `WEBEX_CLIENT_ID` + `WEBEX_CLIENT_SECRET` + `WEBEX_REFRESH_TOKEN` are set, the service:

1. **At startup**, POSTs to `https://webexapis.com/v1/access_token` with `grant_type=refresh_token` and stores the returned `access_token` in memory. All subsequent admin API calls use this in-memory token, so it transparently picks up the rotation.
2. **Schedules the next refresh** for `expires_in - 5 minutes` after each successful refresh (with a hard floor of 60s and ceiling of 11h). Webex access tokens typically last 12 hours, so the bot self-rotates roughly every ~11h 55m.
3. **If a refresh fails** (network blip, transient 5xx), retries every minute until it succeeds — the existing in-memory token continues to be used in the meantime.
4. **If Webex returns a rotated `refresh_token`** in the response (rare but supported by the OAuth spec), the service updates its in-memory `WEBEX_REFRESH_TOKEN` and logs a warning telling you to update `.env` so the new value survives the next process restart.

If `WEBEX_ACCESS_TOKEN` is set instead, the service uses it as-is and does not rotate. The token will expire on Webex's normal schedule and you'll have to restart with a fresh one.

### Webex APIs used

| API | Purpose | Token | Where in code |
|---|---|---|---|
| `POST /v1/access_token` (`grant_type=refresh_token`) | Rotate access token | client_id + client_secret + refresh_token | startup + every ~11h |
| `GET /v1/admin/convergedRecordings` | List recordings | service-app | poll + on-demand request |
| `GET /v1/convergedRecordings/{id}` | Download links | service-app | auto-post |
| `GET /v1/convergedRecordings/{id}/metadata` | Queue / agent / call data | service-app | auto-post + on-demand |
| temporary CDN URL from `temporaryDirectDownloadLinks` | Download MP3 | service-app | auto-post |
| `GET /v1/people?email=…` | Email → display name (fallback) | service-app | non-Customer-Assist recordings |
| `POST /v1/messages` (JSON) | Post text / cards | bot | auto-post + on-demand |
| `POST /v1/messages` (multipart) | Post text + file | bot | auto-post + on-demand |
| `POST /webhooks` (one-time) | Register recording webhook | bot | optional |
| Mercury WebSocket via `webex-node` | Receive mentions & card submissions | bot | always |

---

## Operations & troubleshooting

### Bot replies twice to the same `@request`
You have **two** instances of the service running at the same time, both connected to the Mercury WebSocket with the same bot token. Each connection gets its own copy of the event.

Find and kill duplicates:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*src/index.js*" } |
  Select-Object ProcessId, CreationDate, CommandLine | Format-Table -AutoSize
# Then:
Stop-Process -Id <pidHere> -Force
```

Then start fresh: `npm start` in **one** terminal.

### Bot doesn't reply at all
1. Check the service logs — is it running? Did `Listening for @mentions over WebSocket...` print at startup?
2. Is the bot a member of the configured space?
3. Does the WebSocket connection log any reconnect/error messages? It auto-reconnects, but only while the process is alive.

### Auto-post isn't happening
1. The poll log shows recordings, but no "NEW RECORDING DETECTED" appears? → All listed recordings already existed when the service started. By design, those are marked as "already seen" on first poll. **Make a fresh test call** to verify the pipeline.
2. The poll fails with `HTTP 401/403`? → `WEBEX_ACCESS_TOKEN` is missing or doesn't have `spark-admin:recordings_read`, or the service app isn't authorized in the org.
3. Recording detected but not posting? Look for the next log lines: `Downloading audio recording...`, `Saved recording to disk:`, `Posted recording to Webex space...`. Whichever step fails will tell you where to look.

### "Rate limit hit" log lines
- The same person tried to `@bot request` twice within 10 seconds (the second is suppressed), or
- The same person submitted the card twice within 10 seconds.
This is intentional — see [configuration reference](#configuration-reference).

### Old recording's file isn't attached when I `request` it back
Files are saved only at the moment the bot processes a recording for the first time. Recordings from before the service started running, or from a period when `RECORDING_STORAGE_DIR` was disabled, won't be on disk and the per-recording message will be posted without an attachment.

### Service won't start: `Missing required environment variables: ...`
You're missing one of the required values in `.env`. The required combination is `WEBEX_BOT_TOKEN` + `WEBEX_ROOM_ID` + **either** `WEBEX_ACCESS_TOKEN` **or** all three of (`WEBEX_CLIENT_ID`, `WEBEX_CLIENT_SECRET`, `WEBEX_REFRESH_TOKEN`). Reread step 6.

### Logs say `Access token refresh failed: HTTP 400 - invalid_grant`
The refresh token has expired (Webex refresh tokens last ~90 days, but they can be revoked sooner). Run the OAuth flow again to obtain a new `WEBEX_REFRESH_TOKEN`, paste it into `.env`, and restart.

### Logs say `[Token rotation] Webex returned a NEW refresh_token. Update WEBEX_REFRESH_TOKEN in .env`
Webex rotated your refresh token (rare but allowed by spec). The service is using the new value in memory and continues to work, but if you restart the process before updating `.env`, the next refresh will fail. Copy the new value from the log line into `.env` at your earliest convenience.

---

## Security & data handling notes

- **Tokens** (`WEBEX_ACCESS_TOKEN`, `WEBEX_BOT_TOKEN`, `WEBEX_WEBHOOK_SECRET`) live in `.env`, which is gitignored. **Never commit them.** Treat any token that ever appears in chat, screenshots, or commits as compromised — rotate it.
- **Recordings are PII.** The local `recordings/` directory contains call audio. The directory is also gitignored, but make sure the host filesystem permissions, backups, and retention align with your org's call-recording policy.
- **Logs** dump the full Webex API responses, which include `temporaryDirectDownloadLinks` (effectively short-lived bearer-style URLs) and PII (`ownerEmail`, `managedBy.actor.email`, `callingParty.name/number`). The verbose logging is convenient for development; consider turning it down or routing logs through a redacting pipeline before shipping to a centralized log store.
- **Webhook signing.** When the recording webhook is registered, set `WEBEX_WEBHOOK_SECRET`. The service performs constant-time HMAC-SHA1 verification of every inbound payload and rejects unsigned/mis-signed requests with HTTP 401.
- **Server-side clamping.** The Adaptive Card's `count` is clamped to 1–25 server-side regardless of what the client sends, so a tampered submission can't make the bot fetch unbounded data.
- **Room scoping.** The bot only acts on mentions and card submissions whose `roomId` equals `WEBEX_ROOM_ID`. Mentions in other spaces or DMs are silently ignored.

---

## Project layout

```
recording_extraction_to_space/
├── src/
│   └── index.js          # The whole service (single file, ~900 lines)
├── recordings/           # Local backup of every recording (gitignored)
├── .env                  # Your secrets (gitignored)
├── .env.example          # Template
├── .gitignore
├── package.json
├── package-lock.json
└── README.md             # You are here
```

Key files:
- **`src/index.js`** — the service itself. Helpers are colocated in this single file by topic (env, formatting, Webex REST helpers, SDK listeners, webhook handler, server bootstrap).
- **`.env.example`** — copy to `.env` and fill in. Lists every supported variable with a comment.

---

## License

MIT.
