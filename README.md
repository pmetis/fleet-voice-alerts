# Fleet Voice Alerts

> A Geotab add-in that detects fleet exceptions, enriches them with ACE (Geotab AI), and calls supervisors directly — speaking the alert, the history, and the live vehicle location. The supervisor can ask questions and get real answers, all without touching a screen.

Built for the **Geotab Vibe Coding 2026** competition in 5 days, with AI as co-pilot throughout.

---

## Why

In Chile and across Latin America, fleet vehicles operate in areas where data coverage fails — mining roads, mountain passes, remote highways. Email and WhatsApp don't reach there. But voice calls do.

For critical, low-frequency alerts — panic button, decoy vehicle extraction, temperature alarm — a phone call is the only reliable channel.

---

## Architecture

```
MyGeotab (exceptions)
    └── Cloud Scheduler (every 60s)
            └── pollExceptions (Cloud Function)
                    ├── Geotab GetFeed → new ExceptionEvents
                    ├── ACE enrichment → script + cachedQA
                    └── Firestore → calls/ collection

Cloud Scheduler (every 60s)
    └── initiateCall (Cloud Function)
            ├── reads queued calls from Firestore
            ├── checks schedule window
            └── Twilio outbound call
                    └── voiceResponse (webhook)
                            ├── plays TTS script (Google Cloud TTS + GCS cache)
                            ├── Gather (STT) → question from supervisor
                            ├── ACE live query → real-time answer
                            └── callStatusCallback → updates Firestore

Geotab Add-In (Firebase Hosting)
    ├── Setup tab (Twilio, exceptions, contacts, schedule, language)
    └── Dashboard (active calls, queue, log, transcripts)
```

---

## Prerequisites

| Service | Purpose |
|---|---|
| **Google Cloud project** | Cloud Functions, Firestore, Cloud Scheduler, GCS, TTS |
| **Firebase project** | Hosting for the add-in frontend |
| **Twilio account** | Outbound voice calls + STT |
| **Geotab MyGeotab** | Fleet data source + ACE AI |
| **Node.js 20+** | Local development |
| **gcloud CLI** | Deploying Cloud Functions |
| **Firebase CLI** | Deploying the add-in |

---

## 1. Google Cloud Setup

### 1.1 Create project and enable APIs

```bash
gcloud projects create YOUR_PROJECT_ID
gcloud config set project YOUR_PROJECT_ID

gcloud services enable \
  cloudfunctions.googleapis.com \
  firestore.googleapis.com \
  cloudscheduler.googleapis.com \
  storage.googleapis.com \
  texttospeech.googleapis.com \
  appengine.googleapis.com
```

### 1.2 Create Firestore database

```bash
gcloud firestore databases create --location=us-central1
```

### 1.3 Create GCS bucket for TTS cache

```bash
gsutil mb -l us-central1 gs://fleet-voice-alerts-tts-YOUR_PROJECT_ID
gsutil iam ch allUsers:objectViewer gs://fleet-voice-alerts-tts-YOUR_PROJECT_ID
```

### 1.4 Generate encryption key for stored credentials

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save this value — you'll need it for every `deploy` command as `CONFIG_ENCRYPTION_KEY`.

---

## 2. Twilio Setup

1. Create a Twilio account at [twilio.com](https://twilio.com)
2. Buy a phone number with **Voice** capability
3. Note your **Account SID**, **Auth Token**, and **From Number**
4. Under the phone number's Voice Configuration, set:
   - **A call comes in**: Webhook → `https://REGION-PROJECT.cloudfunctions.net/voiceResponse`
   - **Call Status Changes**: `https://REGION-PROJECT.cloudfunctions.net/callStatusCallback`

---

## 3. Deploy Cloud Functions

### 3.1 Clone and install

```bash
git clone https://github.com/YOUR_ORG/fleet-voice-alerts.git
cd fleet-voice-alerts
npm install
```

### 3.2 Deploy all functions

```bash
# Set your encryption key first (PowerShell: $env:CONFIG_ENCRYPTION_KEY = "...")
export CONFIG_ENCRYPTION_KEY="your-32-byte-hex-key"
export TTS_BUCKET="fleet-voice-alerts-tts-YOUR_PROJECT_ID"

npm run deploy:all
```



### 3.3 Set environment variables on each function

```bash
FUNCTIONS=(pollExceptions initiateCall voiceResponse callStatusCallback synthesize)

for fn in "${FUNCTIONS[@]}"; do
  gcloud functions deploy $fn \
    --update-env-vars CONFIG_ENCRYPTION_KEY="your-key",TTS_BUCKET="your-bucket"
done
```

---

## 4. Cloud Scheduler Jobs

```bash
PROJECT_ID=$(gcloud config get-value project)
REGION=us-central1
BASE_URL="https://${REGION}-${PROJECT_ID}.cloudfunctions.net"

# Poll Geotab for new exceptions every 60 seconds
gcloud scheduler jobs create http poll-fleet-exceptions \
  --location=$REGION \
  --schedule="* * * * *" \
  --uri="$BASE_URL/pollExceptions" \
  --http-method=POST \
  --message-body='{}' \
  --time-zone="UTC" \
  --attempt-deadline=570s

# Initiate queued calls every 60 seconds
gcloud scheduler jobs create http initiate-fleet-calls \
  --location=$REGION \
  --schedule="* * * * *" \
  --uri="$BASE_URL/initiateCall" \
  --http-method=POST \
  --message-body='{}' \
  --time-zone="UTC" \
  --attempt-deadline=120s
```

---

## 5. Deploy the Add-In (Firebase Hosting)

### 5.1 Initialize Firebase

```bash
npm install -g firebase-tools
firebase login
firebase init hosting
# Public directory: . (root)
# Single-page app: No
```

### 5.2 Deploy

```bash
firebase deploy --only hosting
```

The add-in URL will be: `https://YOUR_PROJECT_ID.web.app`

---

## 6. Register the Add-In in MyGeotab

1. In MyGeotab, go to **Administration → System → System Settings → Add-Ins**
2. Click **Add** and paste this JSON:

```json
{
  "name": "Fleet Voice Alerts",
  "supportEmail": "your@email.com",
  "items": [{
    "page": "map",
    "click": "https://YOUR_PROJECT_ID.web.app/index.html",
    "icon": "https://YOUR_PROJECT_ID.web.app/icon.svg",
    "menuName": {
      "en": "Fleet Voice Alerts"
    }
  }],
  "isSigned": false
}
```

3. Save and reload MyGeotab

---

## 7. Configure the Add-In

Open the add-in from MyGeotab and complete each setup tab:

### Twilio
- Account SID
- Auth Token *(stored encrypted in Firestore)*
- From Number (E.164 format: `+15551234567`)
- Webhook Base URL: `https://REGION-PROJECT.cloudfunctions.net`

### Exception Rules
- Enable which Geotab rules trigger calls (e.g. Max Speed, Harsh Braking, Panic Button)
- Set severity per rule: `high` / `medium` / `low`

### Contacts & Escalation
- Add contacts with name + phone number (E.164 format)
- Order defines escalation chain — if contact 1 doesn't answer, contact 2 is called

### Schedule
- Define active hours (e.g. 08:00–20:00)
- Calls outside this window are held until the next active period

### Language
- Interface language: English / Spanish / Portuguese
- Audio language: affects TTS voice and STT recognition

---

## 8. Firestore Data Model

```
configs/{dbName}
  twilioAccountSid, twilioAuthToken (encrypted), twilioFromNumber
  webhookBase, escalationContacts[], exceptionRules[]
  scheduleStart, scheduleEnd, lang

calls/{callId}
  dbName, vehicleId, vehicleName, driverName
  exceptionId, exceptionName, ruleSeverity
  status: queued | dialing | connected | completed | no-answer | dismissed
  script, cachedQA{}, conversation[]
  contactIndex, twilioCallSid
  createdAt, startedAt, endedAt, durationSeconds

feedCursors/{dbName}
  version  ← GetFeed cursor, updated each poll cycle
```

---

## 9. How a Call Works

1. `pollExceptions` detects a new `ExceptionEvent` via `GetFeed`
2. ACE enriches it: generates a spoken script + pre-cached Q&A
3. A `call` document is created in Firestore with `status: queued`
4. `initiateCall` picks it up (within 60s) and dials via Twilio
5. The supervisor hears the alert script spoken by Google WaveNet TTS
6. They can:
   - Press **1** → acknowledge
   - Press **9** → dismiss
   - Ask a question → STT captures it → ACE answers live (with real-time GPS)
7. If no answer → escalates to next contact
8. All turns saved to `conversation[]` in Firestore, visible in the dashboard

---

## 10. Local Development

```bash
# Run a single function locally
npm run start:poll    # pollExceptions
npm run start:voice   # voiceResponse

# Expose local webhook to Twilio
npx ngrok http 8080
# Set Twilio webhook to the ngrok URL
```

---

## Cloud Functions Reference

| Function | Trigger | Purpose |
|---|---|---|
| `pollExceptions` | HTTP (Scheduler) | Fetch new exceptions, enrich with ACE, create call docs |
| `initiateCall` | HTTP (Scheduler) | Dial queued calls via Twilio |
| `voiceResponse` | HTTP (Twilio webhook) | TwiML: play script, gather speech, query ACE |
| `callStatusCallback` | HTTP (Twilio webhook) | Update call status in Firestore |
| `synthesize` | HTTP | Google TTS with GCS caching |
| `getConfig` | HTTP | Read config for a dbName |
| `saveConfig` | HTTP | Save + encrypt config to Firestore |
| `getStatus` | HTTP | Dashboard data (active/queued/log + KPIs) |
| `getConversation` | HTTP | Full transcript for a call |
| `retryCall` | HTTP | Re-queue a failed call from contact 0 |
| `dismissCall` | HTTP | Mark a call as dismissed |
| `testTwilio` | HTTP | Validate Twilio credentials |

---

## Tech Stack

- **Backend**: Node.js 20, Google Cloud Functions (gen2)
- **Database**: Firestore (multi-tenant by `dbName`)
- **Voice**: Twilio Programmable Voice + TwiML
- **STT**: Twilio Speech Recognition (Google backend)
- **TTS**: Google Cloud Text-to-Speech (WaveNet), cached in GCS
- **AI**: Geotab ACE (stateful chat sessions)
- **Frontend**: Vanilla JS, Firebase Hosting
- **Security**: AES-256-GCM encryption for all stored credentials

---

## License

© 2026 Triplezeta. All rights reserved.