// /home/openpi/.openclaw/extensions/openclaw-voice-bridge/index.ts
// Audio Interaction Plugin
// - Listens for HTTP POST from snarling B button
// - Records audio from USB mic using arecord
// - Transcribes via OpenClaw's STT runtime (uses resolved auth)
// - Injects transcript as a user message to the current agent session

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { exec, execFile } from "child_process";
import { readFile, unlink } from "fs/promises";
import { appendFileSync } from "fs";
import { randomUUID } from "crypto";

const SNARLING_URL = "http://localhost:5000/state";
const RECORDING_PATH = "/tmp/voice_recording.wav";
const DEFAULT_MIC_DEVICE = "plughw:3,0";
const DEFAULT_RECORDING_DURATION = 10; // seconds
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

// State: are we currently recording?
let isRecording = false;

// Cached API key resolved from OpenClaw auth runtime
let cachedApiKey: string | null = null;

// Helper: post state to snarling display
async function setSnarlingState(state: string): Promise<void> {
  try {
    await fetch(SNARLING_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, timestamp: Date.now() })
    });
  } catch (_e) {
    // Silent fail - snarling is optional
  }
}

// Helper: record audio from USB mic
function recordAudio(device: string, duration: number, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = `arecord -D ${device} -f S16_LE -c 1 -r 24000 -d ${duration} ${outputPath}`;
    exec(cmd, { timeout: (duration + 5) * 1000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`arecord failed: ${error.message}${stderr ? ` (${stderr.trim()})` : ""}`));
      } else {
        resolve();
      }
    });
  });
}

// Helper: transcribe audio via OpenAI API using resolved API key
async function transcribeAudio(audioPath: string, apiKey: string, model: string): Promise<string> {
  // Read the WAV file
  const audioBuffer = await readFile(audioPath);

  // Create multipart form data manually (no dependencies needed)
  const boundary = `----FormBoundary${randomUUID().replace(/-/g, "")}`;
  const filename = "recording.wav";

  // Build multipart body
  const parts: Buffer[] = [];

  // file field
  parts.push(Buffer.from(`--${boundary}\r\n`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`));
  parts.push(Buffer.from(`Content-Type: audio/wav\r\n\r\n`));
  parts.push(audioBuffer);
  parts.push(Buffer.from(`\r\n`));

  // model field
  parts.push(Buffer.from(`--${boundary}\r\n`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="model"\r\n\r\n`));
  parts.push(Buffer.from(model));
  parts.push(Buffer.from(`\r\n`));

  // response_format field
  parts.push(Buffer.from(`--${boundary}\r\n`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="response_format"\r\n\r\n`));
  parts.push(Buffer.from("json"));
  parts.push(Buffer.from(`\r\n`));

  // language field (optional, helps accuracy)
  parts.push(Buffer.from(`--${boundary}\r\n`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="language"\r\n\r\n`));
  parts.push(Buffer.from("en"));
  parts.push(Buffer.from(`\r\n`));

  // End boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    },
    body
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Transcription API error: ${response.status} ${errorText}`);
  }

  const result = await response.json() as { text: string };
  return result.text?.trim() || "";
}

// Resolve the OpenAI API key through OpenClaw's auth runtime
async function resolveOpenAIKey(runtime: any): Promise<string | null> {
  // Try OpenClaw's auth runtime first (proper way)
  if (runtime?.modelAuth?.resolveApiKeyForProvider) {
    try {
      const auth = await runtime.modelAuth.resolveApiKeyForProvider({ provider: "openai" });
      if (auth?.apiKey) {
        cachedApiKey = auth.apiKey;
        console.error(`[openclaw-voice-bridge] Resolved OpenAI key via auth runtime (source: ${auth.source || "unknown"})`);
        return auth.apiKey;
      }
    } catch (e) {
      console.error(`[openclaw-voice-bridge] Auth runtime resolution failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Fallback: check process.env (for dev/local testing)
  if (process.env.OPENAI_API_KEY) {
    cachedApiKey = process.env.OPENAI_API_KEY;
    console.error("[openclaw-voice-bridge] Resolved OpenAI key from process.env");
    return process.env.OPENAI_API_KEY;
  }

  // Fallback: use cached key if available
  if (cachedApiKey) {
    console.error("[openclaw-voice-bridge] Using cached OpenAI key");
    return cachedApiKey;
  }

  return null;
}

export default definePluginEntry({
  id: "openclaw-voice-bridge",
  name: "Audio Interaction Plugin",

  register(api: any) {
    console.error("[openclaw-voice-bridge] Registering plugin...");

    // Get config values
    const config = api.pluginConfig || api.getConfig?.() || {};
    const micDevice = config.micDevice || process.env.AUDIO_MIC_DEVICE || DEFAULT_MIC_DEVICE;
    const maxDuration = config.recordingDurationSec || DEFAULT_RECORDING_DURATION;
    const transcriptionModel = config.transcriptionModel || DEFAULT_TRANSCRIPTION_MODEL;

    // Resolve API key at startup to verify auth is available
    resolveOpenAIKey(api.runtime).then((key) => {
      if (key) {
        console.error("[openclaw-voice-bridge] OpenAI auth available at startup");
      } else {
        console.error("[openclaw-voice-bridge] WARNING: No OpenAI API key available - voice transcription will fail");
      }
    });

    // Register HTTP route for snarling B button
    if (api.registerHttpRoute) {
      api.registerHttpRoute({
        method: "POST",
        path: "/start-listening",
        auth: "gateway",
        match: "exact",
        replaceExisting: true,
        handler: async (req: any, res: any) => {
          try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} HANDLER ENTERED\n`); } catch(_e) {}
          // Parse body
          let body: any = {};
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            }
            const raw = Buffer.concat(chunks).toString();
            if (raw) body = JSON.parse(raw);
          } catch (_e) {
            // Empty body is fine
          }

          // If already recording, reject
          if (isRecording) {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: "Already recording" }));
            return true;
          }

          const duration = Math.min(body?.duration || maxDuration, 30); // Cap at 30s

          // Resolve API key through OpenClaw auth runtime
          const apiKey = await resolveOpenAIKey(api.runtime);
            try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} Resolved API key: ${apiKey ? apiKey.slice(0,8) + "..." + apiKey.slice(-4) : "null"}\n`); } catch(_e) {}

          if (!apiKey) {
            console.error("[openclaw-voice-bridge] No OpenAI API key available (tried auth runtime + env)");
            try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} No OpenAI key available\n`); } catch(_e) {}
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "OpenAI API key not configured. Configure via: openclaw auth login openai" }));
            return true;
          }

          isRecording = true;
          try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} isRecording=true, pre-recording\n`); } catch(_e) {}

          // Show "listening" state on snarling
          await setSnarlingState("processing");

          // Respond immediately - recording happens in background
          res.statusCode = 200;
          res.end(JSON.stringify({ status: "recording", duration, debug: "v2" }));

          // Record, transcribe, and inject - all async
          (async () => {
            try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} Async handler STARTED\n`); } catch(_e) {}
            let wavPath = `${RECORDING_PATH}.${Date.now()}.wav`;
            try {
              console.error(`[openclaw-voice-bridge] Recording ${duration}s from ${micDevice}...`);

              // Step 1: Record audio
              await recordAudio(micDevice, duration, wavPath);

              // Show "thinking" state
              await setSnarlingState("processing");

              console.error(`[openclaw-voice-bridge] Recording complete, transcribing...`);

              // Step 2: Transcribe
              const transcript = await transcribeAudio(wavPath, apiKey, transcriptionModel);

              console.error(`[openclaw-voice-bridge] Transcript: "${transcript}"`);
              try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} Transcript: "${transcript}"\n`); } catch(_e) {}

              // Clean up WAV file
              try { await unlink(wavPath); } catch (_e) { /* ignore */ }

              if (!transcript) {
                console.error("[openclaw-voice-bridge] Empty transcript, nothing to send");
                await setSnarlingState("sleeping");
                isRecording = false;
                return;
              }

              // Step 3: Inject transcript and wake agent via TaskFlow
              // The interaction bridge's approval callbacks work because they resume a TaskFlow,
              // which inherently wakes the agent. We use the same pattern for voice input:
              // create TaskFlow → setWaiting → resume (with transcript) → finish
              const voiceText = `🎤 Voice input: ${transcript}`;
              const sessionKey = "main:main";
              console.error(`[openclaw-voice-bridge] Injecting transcript via TaskFlow wake`);

              try {
                // /hooks/wake handles enqueueSystemEvent internally, so we don't call it separately.
                // Try TaskFlow-based wake (createManaged → setWaiting → resume → finish)
                // This works when the agent is already active and waiting on a TaskFlow.
                // When agent is idle, we still try it + runtime wake APIs.
                const taskFlowApi = api.runtime?.taskFlow?.bindSession?.({
                  sessionKey,
                  requesterOrigin: "openclaw-voice-bridge"
                }) || api.runtime?.tasks?.flows?.bindSession?.({
                  sessionKey,
                  requesterOrigin: "openclaw-voice-bridge"
                });
                console.error(`[openclaw-voice-bridge] taskFlowApi type: ${typeof taskFlowApi}, keys: ${taskFlowApi ? Object.keys(taskFlowApi).join(',') : 'n/a'}`);

                if (taskFlowApi && typeof taskFlowApi.createManaged === 'function') {
                  const flow = taskFlowApi.createManaged({
                    controllerId: "openclaw-voice-bridge",
                    goal: voiceText,
                    status: "queued",
                    currentStep: "voice-input",
                  });
                  const flowId = flow?.flowId || flow?.id;
                  const flowRev = flow?.revision ?? 0;
                  console.error(`[openclaw-voice-bridge] Created TaskFlow flowId=${flowId} rev=${flowRev}`);

                  const waiting = taskFlowApi.setWaiting({
                    flowId: flowId,
                    expectedRevision: flowRev,
                    currentStep: "voice-input",
                    waitJson: { transcript },
                  });
                  console.error(`[openclaw-voice-bridge] setWaiting result: applied=${waiting?.applied}, flowRev=${waiting?.flow?.revision}`);

                  if (waiting?.applied) {
                    const resumed = taskFlowApi.resume({
                      flowId: flowId,
                      expectedRevision: waiting.flow.revision,
                      status: "running",
                      currentStep: "voice-input",
                      stateJson: { transcript, voiceText },
                    });
                    console.error(`[openclaw-voice-bridge] resume result: applied=${resumed?.applied}`);

                    if (resumed?.applied) {
                      taskFlowApi.finish({
                        flowId: flowId,
                        expectedRevision: resumed.flow.revision,
                        stateJson: { transcript, voiceText },
                      });
                      console.error(`[openclaw-voice-bridge] TaskFlow finished`);
                    }
                  }
                } else {
                  console.error(`[openclaw-voice-bridge] TaskFlow createManaged not available`);
                }

                // Also try runtime wake APIs (belt and suspenders)
                try {
                  api.runtime?.system?.requestHeartbeatNow?.({ reason: "voice-input", sessionKey, coalesceMs: 0 });
                  console.error(`[openclaw-voice-bridge] requestHeartbeatNow called`);
                } catch (_e) {}
                try {
                  api.runtime?.system?.runHeartbeatOnce?.({ sessionKey, reason: "voice-input", heartbeat: { target: "last" } });
                  console.error(`[openclaw-voice-bridge] runHeartbeatOnce called`);
                } catch (_e) {}

                // Use the official /hooks/wake endpoint — this enqueues the system event AND wakes the agent
                try {
                  const http = await import('http');
                  const wakePayload = JSON.stringify({ text: voiceText, mode: "now" });
                  const wakeReq = http.request({
                    hostname: 'localhost',
                    port: 18789,
                    path: '/hooks/wake',
                    method: 'POST',
                    headers: {
                      'Authorization': 'Bearer voicebridge-local-hooks-secret',
                      'Content-Type': 'application/json',
                      'Content-Length': Buffer.byteLength(wakePayload),
                    },
                  }, (res: any) => {
                    let body = '';
                    res.on('data', (chunk: any) => body += chunk);
                    res.on('end', () => {
                      console.error(`[openclaw-voice-bridge] /hooks/wake response: ${res.statusCode} ${body.slice(0, 100)}`);
                      try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} /hooks/wake response: ${res.statusCode} ${body.slice(0, 100)}\n`); } catch(_e) {}
                    });
                  });
                  wakeReq.on('error', (e: any) => {
                    console.error(`[openclaw-voice-voice-bridge] /hooks/wake error: ${e.message}`);
                    try { appendFileSync("/tmp/voice-bridge-debug.log", `${new Date().toISOString()} /hooks/wake error: ${e.message}\n`); } catch(_e) {}
                  });
                  wakeReq.write(wakePayload);
                  wakeReq.end();
                } catch (_e) {}
              } catch (err: any) {
                console.error(`[openclaw-voice-bridge] Wake error: ${err?.message || err}`);
              }
              // Go back to sleeping (don't await - let CLI run async)
              setSnarlingState("sleeping").catch(() => {});
              isRecording = false;

            } catch (err) {
              console.error(`[openclaw-voice-bridge] Error: ${err instanceof Error ? err.message : String(err)}`);
              // Clean up on error
              try { await unlink(wavPath); } catch (_e) { /* ignore */ }
              await setSnarlingState("sleeping");
              isRecording = false;
            }
          })();

          return true;
        }
      });

      console.error("[openclaw-voice-bridge] Registered /start-listening route");

      // Status endpoint
      api.registerHttpRoute({
        method: "GET",
        path: "/audio-status",
        auth: "gateway",
        match: "exact",
        replaceExisting: true,
        handler: async (_req: any, res: any) => {
          res.statusCode = 200;
          res.end(JSON.stringify({
            recording: isRecording,
            micDevice,
            transcriptionModel,
            authAvailable: cachedApiKey ? true : "unknown"
          }));
          return true;
        }
      });

      console.error("[openclaw-voice-bridge] Registered /audio-status route");
    }

    // Register a tool so the agent can also trigger voice recording
    api.registerTool((ctx: any) => {
      const sessionKey = ctx?.sessionKey;

      return {
        name: "voice_record",
        description: "Record audio from the USB microphone and transcribe it. Returns the transcript text. Use this when you want to listen to voice input.",
        parameters: {
          type: "object",
          properties: {
            duration: {
              type: "number",
              description: "Recording duration in seconds (default: 5, max: 30)"
            }
          }
        },
        async execute(_toolCallId: string, params: any) {
          const duration = Math.min(params?.duration || 5, 30);
          const apiKey = await resolveOpenAIKey(api.runtime);

          if (!apiKey) {
            return { content: [{ type: "text", text: "Error: OpenAI API key not configured. Configure via: openclaw auth login openai" }] };
          }

          if (isRecording) {
            return { content: [{ type: "text", text: "Error: Already recording" }] };
          }

          isRecording = true;

          try {
            const wavPath = `${RECORDING_PATH}.${Date.now()}.wav`;
            await recordAudio(micDevice, duration, wavPath);
            const transcript = await transcribeAudio(wavPath, apiKey, transcriptionModel);
            try { await unlink(wavPath); } catch (_e) { /* ignore */ }
            isRecording = false;

            return {
              content: [{
                type: "text",
                text: transcript || "(No speech detected)"
              }]
            };
          } catch (err) {
            isRecording = false;
            return {
              content: [{
                type: "text",
                text: `Error recording/transcribing: ${err instanceof Error ? err.message : String(err)}`
              }]
            };
          }
        }
      };
    }, { optional: true });
  }
});

