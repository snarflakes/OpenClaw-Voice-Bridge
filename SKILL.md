---
name: openclaw-voice-bridge
description: "Push-to-talk voice input via Snarling hardware button and USB mic. Records audio, transcribes via Whisper, and injects the transcript as a system event for the agent to respond to. Includes Snarling display notification relay for visual confirmation."
type: code-plugin
envVars:
  - OPENAI_API_KEY
---

# OpenClaw Voice Bridge

> Push-to-talk voice input via Snarling hardware button + USB mic → Whisper transcription → agent system event

## What It Does

When a user presses the **X button** on a Snarling display, the hardware sends a POST to `/start-listening` on the OpenClaw gateway. The voice bridge plugin records 10 seconds of audio from the USB mic, transcribes it via OpenAI Whisper, and injects the transcript as a system event prefixed with `🎤 Voice input:`.

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
| `/start-listening` | POST | gateway token | Start a 10s recording. Returns `{status: "recording", duration: N}` |
| `/audio-status` | GET | gateway token | Returns `{recording: bool, micDevice, transcriptionModel, authAvailable}` |

### Starting a Recording

```bash
curl -X POST http://localhost:18789/start-listening \
  -H "Authorization: Bearer <gateway-token>" \
  -H "Content-Type: application/json" \
  -d '{"duration": 10}'
```

Duration is optional (default: 10s, max: 30s).

## Snarling Button Mapping

| Button | Normal State | Approval State | Notification State |
|--------|-------------|----------------|-------------------|
| **X** | Voice input | — | — |
| **Y** | Sleep mode | — | — |
| **B** | No-op | Reject | Dismiss |
| **A** | — | Approve | Reveal |

The X button only triggers voice input when no approval or notification is active.

## Known Limitations

### Wake Gap

Voice transcripts are enqueued via `enqueueSystemEvent()`. The agent only processes system events on the next heartbeat (default: 30 minutes). This means:

- **Voice input is NOT delivered in real-time** — there is a delay until the next heartbeat
- Reducing the heartbeat interval (e.g., to 15-30 seconds) shortens this gap
- The `requestHeartbeatNow()` and `runHeartbeatOnce()` runtime methods do **not** wake an idle agent
- This is a known architecture gap — no plugin-side API can trigger an immediate agent turn

### Recording Quality

- USB mic picks up audio within ~1-2 feet
- Empty transcripts are silently skipped (not enqueued)
- Whisper may truncate trailing words with "..."
- Background noise can cause false activations

## Plugin Location

- Source: `~/.openclaw/extensions/openclaw-voice-bridge/index.ts`
- Compiled: `~/.openclaw/extensions/openclaw-voice-bridge/index.mjs`
- Config: `openclaw.plugin.json` with `micDevice`, `recordingDurationSec`, `transcriptionModel`
- GitHub: https://github.com/snarflakes/OpenClaw-Voice-Bridge (development branch)

## Debugging

Debug logs at `/tmp/voice-bridge-debug.log` (when enabled in plugin code). WAV files are created at `/tmp/voice_recording.wav.<timestamp>.wav` during recording and deleted after transcription.

After code changes to the plugin, a **full process restart** is required (`systemctl --user restart openclaw-gateway`). SIGUSR1 hot-reload only reloads config, not plugin code.