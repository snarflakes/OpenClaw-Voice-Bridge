# OpenClaw Voice Bridge

Push-to-talk voice input for OpenClaw, triggered by a hardware button on the Snarling display. Records audio from a USB microphone, transcribes via OpenAI Whisper, and delivers the transcript to your agent instantly.

## How It Works

```
┌─────────────┐    POST /start-listening     ┌──────────────────┐
│  Snarling    │ ───────────────────────────▶ │  Voice Bridge    │
│  X Button    │                              │  Plugin          │
│  Display     │ ◀─── "recording" ─────────── │                  │
└─────────────┘                                │                  │
                                               │  1. arecord 20s │
                                               │  2. Whisper API │
                                               │  3. /hooks/wake  │
                                               └────────┬────────┘
                                                        │
                                                        ▼
                                               ┌──────────────────┐
                                               │  OpenClaw Agent  │
                                               │  🎤 Voice input:  │
                                               │  "Hello there!"  │
                                               └──────────────────┘
```

1. Press **X** on the Snarling display
2. The plugin records 20 seconds from the USB mic (starts within ~82ms)
3. Audio is transcribed via `gpt-4o-mini-transcribe`
4. Transcript is injected as a system event via `/hooks/wake` — agent wakes immediately

## Hardware

| Component | Notes |
|-----------|-------|
| **Computer** | Raspberry Pi 4 or higher (recommended) |
| **Display** | Pimoroni Display HAT Mini (320×240 IPS) |
| **Microphone** | USB PnP Sound Device (`plughw:3,0`) |
| **Audio format** | 24kHz, 16-bit little-endian, mono (WAV) |
| **Trigger** | X button on Snarling display |

The USB mic plugs directly into the Pi. The Pimoroni Display HAT Mini sits on the Pi's GPIO header and runs the Snarling software, which renders the UI and handles button input.

## Button Mapping

| Button | Normal State | Approval State | Notification State |
|--------|-------------|----------------|-------------------|
| **X** | 🎙️ Voice input | — | — |
| **Y** | 💤 Sleep mode | — | — |
| **B** | No-op | ❌ Reject | ✕ Dismiss |
| **A** | — | ✅ Approve | 👁️ Reveal |

The X button only triggers voice input when no approval or notification is active. This prevents accidental recording during A/B interactions.

## Installation

### 1. Install the plugin

```bash
openclaw plugins install clawhub:openclaw-voice-bridge
```

Or clone from GitHub and link manually:

```bash
git clone -b development https://github.com/snarflakes/OpenClaw-Voice-Bridge.git \
  ~/.openclaw/extensions/openclaw-voice-bridge
```

### 2. Enable the plugin in `openclaw.json`

```json
{
  "openclaw-voice-bridge": {
    "enabled": true,
    "config": {},
    "hooks": {
      "allowConversationAccess": true
    }
  }
}
```

> ⚠️ **`hooks.allowConversationAccess: true` is required** (v2026.5.18+). Without it, the plugin loads lazily and its HTTP routes are invisible to the gateway's HTTP server. This caused mysterious 404 errors on `/start-listening`.

### 3. Ensure hooks are enabled

The plugin uses `POST /hooks/wake` to deliver transcripts instantly. Your `openclaw.json` must have:

```json
{
  "hooks": {
    "enabled": true,
    "token": "your-hooks-secret"
  }
}
```

The hooks token **must be distinct** from the gateway admin token — reusing it is rejected by the gateway.

### 4. Verify your mic

```bash
arecord -l
```

You should see your USB device listed. The default device is `plughw:3,0` — if yours differs, set it in plugin config:

```json
{
  "openclaw-voice-bridge": {
    "enabled": true,
    "config": {
      "micDevice": "plughw:2,0"
    },
    "hooks": { "allowConversationAccess": true }
  }
}
```

Quick test:

```bash
arecord -D plughw:3,0 -f S16_LE -c 1 -r 24000 -d 5 /tmp/test.wav
```

### 5. Restart the gateway

```bash
systemctl --user restart openclaw-gateway
```

SIGUSR1 hot-reload only reloads config, not plugin code. A full process restart is required after installation or code changes.

## Configuration

All config lives in `openclaw.json` under the `openclaw-voice-bridge.config` key:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `micDevice` | string | `plughw:3,0` | ALSA device for the USB microphone |
| `recordingDurationSec` | number | `20` | Recording duration in seconds (max: 30) |
| `transcriptionModel` | string | `gpt-4o-mini-transcribe` | OpenAI transcription model |

## API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/start-listening` | POST | gateway token | Start a recording. Returns `{status: "recording", duration: N}` |
| `/audio-status` | GET | gateway token | Returns `{recording: bool, micDevice, transcriptionModel, authAvailable}` |
| `/hooks/wake` | POST | hooks token | Used internally by the plugin to deliver transcripts and wake the agent |

### Start a recording manually

```bash
curl -X POST http://localhost:18789/start-listening \
  -H "Authorization: Bearer <gateway-token>" \
  -H "Content-Type: application/json" \
  -d '{"duration": 20}'
```

### Check recording status

```bash
curl http://localhost:18789/audio-status \
  -H "Authorization: Bearer <gateway-token>"
```

## Agent Integration

Voice transcripts arrive as system events:

```
🎤 Voice input: What's the weather like today?
```

Agents should **treat these as direct user messages** — respond naturally, as if the user typed the words in chat. Always relay the response as a notification to the Snarling display so there's visual confirmation.

For full agent integration instructions, see [SKILL.md](./SKILL.md).

## Recording Pipeline (v4)

The v4 pipeline starts the microphone and OpenAI key resolution **in parallel**, eliminating the 5-6s front-clipping that occurred in earlier versions:

```
X button pressed
     │
     ├── isRecording = true
     ├── 200 OK sent immediately
     │
     ├── arecord starts (82ms) ──────────▶ WAV file (20s)
     │                                        │
     └── resolveOpenAIKey (background) ────▶ API key ready
                                              │
                                    ┌─────────┴─────────┐
                                    │  Transcribe WAV   │
                                    │  via Whisper API  │
                                    └─────────┬─────────┘
                                              │
                                    ┌─────────┴─────────┐
                                    │  POST /hooks/wake  │
                                    │  {text, mode:now}  │
                                    └─────────┬─────────┘
                                              │
                                              ▼
                                    Agent processes voice input
```

## Transcription Models

| Model | Latency | Cost/20s | Quality | Best Use |
|-------|---------|----------|---------|----------|
| `gpt-4o-mini-transcribe` | ~2s | ~$0.006 | Very good | Default — best value |
| `gpt-4o-transcribe` | ~3-5s | ~$0.012 | Best | Noisy environments |
| `whisper-1` | ~3-5s | ~$0.012 | Good | Legacy, timestamps |

## Troubleshooting

### `/start-listening` returns 404

The plugin isn't loading at startup. Add `hooks.allowConversationAccess: true` to its config in `openclaw.json` (see Installation step 2). Requires gateway restart.

### Voice transcript is empty or cut off

- Check mic volume: `alsamixer -c 3` (card number from `arecord -l`)
- Test directly: `arecord -D plughw:3,0 -f S16_LE -c 1 -r 24000 -d 5 /tmp/test.wav && aplay /tmp/test.wav`
- If recording starts but transcript is truncated, increase `recordingDurationSec`

### Agent doesn't respond to voice input

- Verify hooks are enabled in `openclaw.json` (`hooks.enabled: true` + `hooks.token`)
- Check gateway logs for `/hooks/wake` response: should return `{"ok": true}`
- System events are queued — if the agent is mid-turn, the transcript waits for the next turn

### Front of recording is clipped (missing first words)

This was fixed in v4 (parallel arecord + key resolution). If you're running an older version, update. After a gateway restart, the first recording may have a ~5s delay while the API key cache is cold — subsequent recordings start in ~82ms.

### esbuild rebuild breaks transcription

⚠️ **Do not rebuild `index.mjs` from `index.ts` via esbuild.** The esbuild output differs subtly from the hand-curated version and breaks transcription. Apply patches surgically to `index.mjs` directly.

## v2026.5.18 Compatibility

OpenClaw v2026.5.18 introduced breaking changes requiring manifest updates:

1. **`contracts.tools` required** — plugins must declare tool names before `api.registerTool()` succeeds. This plugin declares `"contracts": { "tools": ["voice_record"] }` in its manifest.
2. **`hooks.allowConversationAccess` required** — without this config, the plugin loads lazily and its HTTP routes are invisible to the server.
3. **Schema defaults override code defaults** — if the manifest config schema has `"default": X`, it overrides `const FOO = Y` in the code. Keep both in sync.

## License

MIT

## Links

- **GitHub**: https://github.com/snarflakes/OpenClaw-Voice-Bridge
- **ClawHub**: https://clawhub.ai/skills/openclaw-voice-bridge
- **Snarling Display**: https://github.com/snarflakes/snarling