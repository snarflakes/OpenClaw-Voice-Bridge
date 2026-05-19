---
name: openclaw-voice-bridge
description: "Push-to-talk voice input via Snarling hardware button and USB mic. Records audio, transcribes via Whisper, and injects the transcript as a system event for the agent to respond to. Includes Snarling display notification relay for visual confirmation."
type: code-plugin
envVars:
  - OPENAI_API_KEY
---

# OpenClaw Voice Bridge

> Push-to-talk voice input via Snarling hardware button + USB mic → Whisper transcription → agent system event (instant wake via /hooks/wake)

## What It Does

When a user presses the **X button** on a Snarling display, the hardware sends a POST to `/start-listening` on the OpenClaw gateway. The voice bridge plugin records 20 seconds of audio from the USB mic, transcribes it via OpenAI Whisper (`gpt-4o-mini-transcribe`), and injects the transcript as a system event via `/hooks/wake` — which enqueues the text AND triggers an immediate agent heartbeat. The agent sees the voice input within ~2s of recording completion.

## v2026.5.18+ Requirements

- **`contracts.tools`** must be declared in `openclaw.plugin.json` manifest:
  ```json
  { "contracts": { "tools": ["voice_record"] } }
  ```
- **`hooks.allowConversationAccess: true`** must be in the plugin's config in `openclaw.json` — without this, the plugin loads lazily and its HTTP routes are invisible to the server:
  ```json
  { "openclaw-voice-bridge": { "enabled": true, "config": {}, "hooks": { "allowConversationAccess": true } } }
  ```

## System Events

Voice transcripts arrive as system events in the format:

```
🎤 Voice input: <transcribed text>
```

**Treat these as direct user messages.** Respond to the content naturally, as if the user said it in chat. Do not ignore them or treat them as informational background.

## Responding to Voice Input

**Always relay your response as a notification to Snarling** so the user gets visual confirmation on the display. After processing the voice transcript:

1. Respond to the voice input normally in the current session
2. Send the response (or a summary) via `send_notification` so it appears on the Snarling display

Example:
- Voice input: `🎤 Voice input: What's the weather?`
- Agent processes the question
- Agent sends: `send_notification(message: "🌤️ LA: Clear, 68°F", priority: "low")`

Keep notification messages under 80 characters (Snarling display limit). For longer responses, summarize the key point in the notification and give the full answer in chat.

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/start-listening` | POST | gateway token | Start a recording (default 20s, max 30s). Returns `{status: "recording", duration: N}` |
| `/audio-status` | GET | gateway token | Returns `{recording: bool, micDevice, transcriptionModel, authAvailable}` |

### Starting a Recording

```bash
curl -X POST http://localhost:18789/start-listening \
  -H "Authorization: Bearer <gateway-token>" \
  -H "Content-Type: application/json" \
  -d '{"duration": 20}'
```

Duration is optional (default: 20s, max: 30s).

## Wake: POST /hooks/wake

After transcription, the plugin calls `POST /hooks/wake { text: transcript, mode: "now" }` which:

1. Enqueues the transcript as a system event in the main session
2. Triggers an immediate agent heartbeat

This is a **single-call** pattern — no separate `enqueueSystemEvent` needed. The agent wakes and processes the voice input within ~2s.

**Auth**: Requires `Authorization: Bearer <hooks-token>` (distinct from gateway admin token).

**Config required** (in `openclaw.json`):
```json
{
  "hooks": {
    "enabled": true,
    "token": "<hooks-token>"
  }
}
```

## Snarling Button Mapping

| Button | Normal State | Approval State | Notification State |
|--------|-------------|----------------|-------------------|
| **X** | Voice input | — | — |
| **Y** | Sleep mode | — | — |
| **B** | No-op | Reject | Dismiss |
| **A** | — | Approve | Reveal |

The X button only triggers voice input when no approval or notification is active.

## Recording Pipeline (v4)

The v4 pipeline starts arecord and OpenAI key resolution **in parallel** — mic begins recording within ~82ms of button press (vs 5-6s delay in earlier versions):

1. X press → snarling POST to `/start-listening`
2. Handler sets `isRecording=true`, sends 200 OK, kicks off two parallel promises:
   - `recordAudio(micDevice, 20s, wavPath)` — arecord starts immediately
   - `resolveOpenAIKey(runtime)` — resolves in background (~5s)
3. Both promises await separately — recording completes regardless of key resolution time
4. Transcription via `gpt-4o-mini-transcribe` (~2s)
5. `POST /hooks/wake { text: transcript, mode: "now" }` — instant agent wake
6. Snarling state set back to sleeping

## Known Limitations

- USB mic picks up audio within ~1-2 feet
- Empty transcripts are silently skipped (not enqueued)
- Whisper may truncate trailing words with "..."
- Background noise can cause false activations
- OpenAI API key is cached after first resolution; first call after restart takes ~5-6s (mitigated by v4 parallel start)

## Plugin Location

- Source: `~/.openclaw/extensions/openclaw-voice-bridge/index.mjs` (hand-curated, NOT esbuild output)
- Config: `openclaw.plugin.json` with `micDevice`, `recordingDurationSec` (default: 20), `transcriptionModel`
- GitHub: https://github.com/snarflakes/OpenClaw-Voice-Bridge (development branch)

## Debugging

Debug logs at `/tmp/voice-bridge-debug.log` (when enabled in plugin code). WAV files are created at `/tmp/voice_recording.wav.<timestamp>.wav` during recording and deleted after transcription.

After code changes to the plugin, a **full process restart** is required (`systemctl --user restart openclaw-gateway`). SIGUSR1 hot-reload only reloads config, not plugin code.

⚠️ **Do NOT esbuild rebuild `index.mjs` from `index.ts`** — the esbuild output differs subtly from the hand-curated git version and breaks transcription. Apply patches surgically to `index.mjs` directly.