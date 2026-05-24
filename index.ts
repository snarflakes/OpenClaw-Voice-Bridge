// /home/openpi/.openclaw/extensions/openclaw-voice-bridge/index.ts
// Voice Bridge Plugin v3 — Snarling owns recording, plugin owns transcription + injection
//
// Flow: snarling X press → arecord (in snarling thread) → POST wav_path to /transcribe-and-reply
// Plugin: receives wav_path → transcribes via OpenAI → enqueues system event → requests heartbeat

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFile, unlink } from "fs/promises";
import { appendFileSync } from "fs";
import { randomUUID } from "crypto";

const SNARLING_URL = "http://localhost:5000/state";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

// Cached API key to avoid re-resolving on every call
let cachedApiKey: string | null = null;

// Helper: set snarling state via /state API
async function setSnarlingState(state: string): Promise<void> {
  try {
    const http = await import('http');
    await new Promise<void>((resolve, reject) => {
      const payload = JSON.stringify({ state });
      const req = http.request({
        hostname: 'localhost',
        port: 5000,
        path: '/state',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res: any) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  } catch (_e) {
    // Snarling may be unreachable, that's ok
  }
}

// Helper: resolve OpenAI API key through OpenClaw auth runtime
async function resolveOpenAIKey(runtime: any): Promise<string | null> {
  // Try cached key first
  if (cachedApiKey) return cachedApiKey;

  // Try OpenClaw's auth runtime (modelAuth.resolveApiKeyForProvider)
  if (runtime?.modelAuth?.resolveApiKeyForProvider) {
    try {
      const auth = await runtime.modelAuth.resolveApiKeyForProvider({ provider: "openai" });
      if (auth?.apiKey) {
        cachedApiKey = auth.apiKey;
        console.info(`[openclaw-voice-bridge] Resolved OpenAI key via modelAuth (source: ${auth.source || "unknown"})`);
        try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} Resolved key via modelAuth (source: ${auth.source || "unknown"})\n`); } catch(_e) {}
        return auth.apiKey;
      }
    } catch (e: any) {
      console.error(`[openclaw-voice-bridge] modelAuth resolution failed: ${e?.message || String(e)}`);
      try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} modelAuth failed: ${e?.message || String(e)}\n`); } catch(_e) {}
    }
  }

  // Fallback: try runtime.auth.resolveKey (older API)
  try {
    const key = await runtime?.auth?.resolveKey?.("openai:default");
    if (key) {
      cachedApiKey = key;
      console.info(`[openclaw-voice-bridge] Resolved OpenAI key via auth.resolveKey`);
      try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} Resolved key via auth.resolveKey\n`); } catch(_e) {}
      return key;
    }
  } catch (_e) {}

  // Fallback: process.env
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    cachedApiKey = envKey;
    console.info("[openclaw-voice-bridge] Resolved OpenAI key from process.env");
    try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} Resolved key from process.env\n`); } catch(_e) {}
    return envKey;
  }

  console.warn("[openclaw-voice-bridge] No OpenAI API key available");
  try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} No OpenAI key available\n`); } catch(_e) {}
  return null;
}

// Helper: transcribe audio via OpenAI API
async function transcribeAudio(audioPath: string, apiKey: string, model: string): Promise<string> {
  const audioBuffer = await readFile(audioPath);

  const boundary = `----FormBoundary${randomUUID().replace(/-/g, "")}`;
  const filename = "recording.wav";

  const parts: Buffer[] = [];

  // File part
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(audioBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`));

  // Response format
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n`));

  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    import('https').then((https) => {
      const req = https.request({
        hostname: 'api.openai.com',
        port: 443,
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.text || json.error?.message || '');
          } catch {
            resolve(data.trim());
          }
        });
      });
      req.on('error', (e: any) => reject(new Error(`Transcription request failed: ${e.message}`)));
      req.write(body);
      req.end();
    }).catch((e: any) => reject(new Error(`Failed to import https: ${e.message}`)));
  });
}

// Plugin entry
export default definePluginEntry({
  id: "openclaw-voice-bridge",
  name: "OpenClaw Voice Bridge",
  description: "Receives WAV audio paths from snarling, transcribes via OpenAI, and injects transcript into agent session",
  register(api: any) {
    console.info("[openclaw-voice-bridge] v3 registering, api keys:", Object.keys(api || {}));
    console.info("[openclaw-voice-bridge] api.runtime:", typeof api?.runtime, api?.runtime ? Object.keys(api.runtime) : 'null');

  // Transcribe-and-reply endpoint — receives wav_path from snarling
  api.registerHttpRoute({
    method: "POST",
    path: "/transcribe-and-reply",
    auth: "gateway",
    match: "exact",
    replaceExisting: true,
    handler: async (req: any, res: any) => {
      let body: any = null;
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const raw = Buffer.concat(chunks).toString();
        if (raw) body = JSON.parse(raw);
      } catch (_e) {}

      const wavPath = body?.wav_path;
      if (!wavPath) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "wav_path required" }));
        return true;
      }

      try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} /transcribe-and-reply wav_path=${wavPath}\n`); } catch(_e) {}

      // Respond immediately
      res.statusCode = 200;
      res.end(JSON.stringify({ status: "transcribing" }));

      // Transcribe and inject — async
      (async () => {
        try {
          const apiKey = await resolveOpenAIKey(api.runtime);
          try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} API key resolved: ${apiKey ? apiKey.slice(0,8) + "..." + apiKey.slice(-4) : "null"}, api.runtime: ${typeof api?.runtime}, api.runtime.auth: ${typeof api?.runtime?.auth}, api.runtime.auth.resolveKey: ${typeof api?.runtime?.auth?.resolveKey}\n`); } catch(_e) {}

          if (!apiKey) {
            console.warn("[openclaw-voice-bridge] No OpenAI API key available");
            try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} No OpenAI key\n`); } catch(_e) {}
            await setSnarlingState("sleeping");
            return;
          }

          // Show thinking state
          await setSnarlingState("processing");

          try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} Starting transcription of ${wavPath}\n`); } catch(_e) {}
          const transcript = await transcribeAudio(wavPath, apiKey, DEFAULT_TRANSCRIPTION_MODEL);
          console.info(`[openclaw-voice-bridge] Transcript: "${transcript}"`);
          try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} Transcript: "${transcript}"\n`); } catch(_e) {}

          if (!transcript) {
            console.info("[openclaw-voice-bridge] Empty transcript, nothing to send");
            await setSnarlingState("sleeping");
            return;
          }

          // Inject and wake
          const voiceText = `🎤 Voice input: ${transcript}`;
          const sessionKey = "agent:main:main";

          try {
            const systemApi = api.runtime?.system;
            let usedRuntimeApi = false;

            if (systemApi?.enqueueSystemEvent && systemApi?.runHeartbeatOnce) {
              try {
                systemApi.enqueueSystemEvent(voiceText, { sessionKey });
                console.info(`[openclaw-voice-bridge] Enqueued system event via runtime API`);
                try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} Enqueued via runtime API\n`); } catch(_e) {}
              } catch (e: any) {
                console.error(`[openclaw-voice-bridge] enqueueSystemEvent error: ${e?.message || e}`);
                try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} enqueueSystemEvent error: ${e?.message || e}\n`); } catch(_e) {}
              }

              try {
                // Fire and forget — don't await, the event is enqueued and the heartbeat will process it
                // Small delay to avoid race condition: enqueueSystemEvent may not be fully committed
                // before runHeartbeatOnce checks the queue
                setTimeout(() => {
                  systemApi.runHeartbeatOnce({
                    agentId: "main",
                    sessionKey,
                    reason: "hook",
                    heartbeat: { target: "last" },
                  }).then((hbResult: any) => {
                    console.info(`[openclaw-voice-bridge] runHeartbeatOnce result:`, JSON.stringify(hbResult));
                    try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} runHeartbeatOnce result: ${JSON.stringify(hbResult)}\n`); } catch(_e) {}
                  }).catch((e: any) => {
                    console.error(`[openclaw-voice-bridge] runHeartbeatOnce error: ${e?.message || e}`);
                    try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} runHeartbeatOnce error: ${e?.message || e}\n`); } catch(_e) {}
                  });
                }, 100);
              } catch (e: any) {
                console.error(`[openclaw-voice-bridge] runHeartbeatOnce error: ${e?.message || e}`);
                try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} runHeartbeatOnce error: ${e?.message || e}\n`); } catch(_e) {}
              }
            }

            // No fallback needed — in-process SDK is the authoritative wake path
          } catch (err: any) {
            console.error(`[openclaw-voice-bridge] Wake error: ${err?.message || err}`);
          }

          // Go back to sleeping
          setSnarlingState("sleeping").catch(() => {});

        } catch (err) {
          console.error(`[openclaw-voice-bridge] Error: ${err instanceof Error ? err.message : String(err)}`);
          try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} ERROR: ${err instanceof Error ? err.message + ' | ' + err.stack : String(err)}\n`); } catch(_e) {}
          await setSnarlingState("sleeping");
        }
      })();

      return true;
    }
  });

  console.info("[openclaw-voice-bridge] Registered /transcribe-and-reply route");

  // Keep /audio-status and /start-listening as legacy endpoints
  api.registerHttpRoute({
    method: "GET",
    path: "/audio-status",
    auth: "gateway",
    match: "exact",
    replaceExisting: true,
    handler: async (_req: any, res: any) => {
      res.statusCode = 200;
      res.end(JSON.stringify({
        version: 3,
        transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
        authAvailable: cachedApiKey ? true : "unknown"
      }));
      return true;
    }
  });

  // Legacy /start-listening — returns error directing to new flow
  api.registerHttpRoute({
    method: "POST",
    path: "/start-listening",
    auth: "gateway",
    match: "exact",
    replaceExisting: true,
    handler: async (_req: any, res: any) => {
      res.statusCode = 410;
      res.end(JSON.stringify({ error: "Deprecated — use /transcribe-and-reply with wav_path", hint: "Snarling should record locally and POST wav_path" }));
      return true;
    }
  });

  console.info("[openclaw-voice-bridge] v3 ready");
  }
});