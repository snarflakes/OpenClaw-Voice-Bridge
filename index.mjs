// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { exec } from "child_process";
import { readFile, unlink } from "fs/promises";
import { appendFileSync } from "fs";
import { randomUUID } from "crypto";
var SNARLING_URL = "http://localhost:5000/state";
var RECORDING_PATH = "/tmp/voice_recording.wav";
var DEFAULT_MIC_DEVICE = "plughw:3,0";
var DEFAULT_RECORDING_DURATION = 10;
var DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
var isRecording = false;
var cachedApiKey = null;
async function setSnarlingState(state) {
  try {
    await fetch(SNARLING_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, timestamp: Date.now() })
    });
  } catch (_e) {
  }
}
function recordAudio(device, duration, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `arecord -D ${device} -f S16_LE -c 1 -r 24000 -d ${duration} ${outputPath}`;
    exec(cmd, { timeout: (duration + 5) * 1e3 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(`arecord failed: ${error.message}${stderr ? ` (${stderr.trim()})` : ""}`));
      } else {
        resolve();
      }
    });
  });
}
async function transcribeAudio(audioPath, apiKey, model) {
  const audioBuffer = await readFile(audioPath);
  const boundary = `----FormBoundary${randomUUID().replace(/-/g, "")}`;
  const filename = "recording.wav";
  const parts = [];
  parts.push(Buffer.from(`--${boundary}\r
`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${filename}"\r
`));
  parts.push(Buffer.from(`Content-Type: audio/wav\r
\r
`));
  parts.push(audioBuffer);
  parts.push(Buffer.from(`\r
`));
  parts.push(Buffer.from(`--${boundary}\r
`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="model"\r
\r
`));
  parts.push(Buffer.from(model));
  parts.push(Buffer.from(`\r
`));
  parts.push(Buffer.from(`--${boundary}\r
`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="response_format"\r
\r
`));
  parts.push(Buffer.from("json"));
  parts.push(Buffer.from(`\r
`));
  parts.push(Buffer.from(`--${boundary}\r
`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="language"\r
\r
`));
  parts.push(Buffer.from("en"));
  parts.push(Buffer.from(`\r
`));
  parts.push(Buffer.from(`--${boundary}--\r
`));
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
  const result = await response.json();
  return result.text?.trim() || "";
}
async function resolveOpenAIKey(runtime) {
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
  if (process.env.OPENAI_API_KEY) {
    cachedApiKey = process.env.OPENAI_API_KEY;
    console.error("[openclaw-voice-bridge] Resolved OpenAI key from process.env");
    return process.env.OPENAI_API_KEY;
  }
  if (cachedApiKey) {
    console.error("[openclaw-voice-bridge] Using cached OpenAI key");
    return cachedApiKey;
  }
  return null;
}
var index_default = definePluginEntry({
  id: "openclaw-voice-bridge",
  name: "Audio Interaction Plugin",
  register(api) {
    console.error("[openclaw-voice-bridge] Registering plugin...");
    const config = api.pluginConfig || api.getConfig?.() || {};
    const micDevice = config.micDevice || process.env.AUDIO_MIC_DEVICE || DEFAULT_MIC_DEVICE;
    const maxDuration = config.recordingDurationSec || DEFAULT_RECORDING_DURATION;
    const transcriptionModel = config.transcriptionModel || DEFAULT_TRANSCRIPTION_MODEL;
    resolveOpenAIKey(api.runtime).then((key) => {
      if (key) {
        console.error("[openclaw-voice-bridge] OpenAI auth available at startup");
      } else {
        console.error("[openclaw-voice-bridge] WARNING: No OpenAI API key available - voice transcription will fail");
      }
    });
    if (api.registerHttpRoute) {
      api.registerHttpRoute({
        method: "POST",
        path: "/start-listening",
        auth: "gateway",
        match: "exact",
        replaceExisting: true,
        handler: async (req, res) => {
          try {
            appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} HANDLER ENTERED
`);
          } catch (_e) {
          }
          let body = {};
          try {
            const chunks = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            }
            const raw = Buffer.concat(chunks).toString();
            if (raw) body = JSON.parse(raw);
          } catch (_e) {
          }
          if (isRecording) {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: "Already recording" }));
            return true;
          }
          const duration = Math.min(body?.duration || maxDuration, 30);
          const apiKey = await resolveOpenAIKey(api.runtime);
          try {
            appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} Resolved API key: ${apiKey ? apiKey.slice(0, 8) + "..." + apiKey.slice(-4) : "null"}
`);
          } catch (_e) {
          }
          if (!apiKey) {
            console.error("[openclaw-voice-bridge] No OpenAI API key available (tried auth runtime + env)");
            try {
              appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} No OpenAI key available
`);
            } catch (_e) {
            }
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "OpenAI API key not configured. Configure via: openclaw auth login openai" }));
            return true;
          }
          isRecording = true;
          try {
            appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} isRecording=true, pre-recording
`);
          } catch (_e) {
          }
          await setSnarlingState("processing");
          res.statusCode = 200;
          res.end(JSON.stringify({ status: "recording", duration, debug: "v2" }));
          (async () => {
            try {
              appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} Async handler STARTED
`);
            } catch (_e) {
            }
            let wavPath = `${RECORDING_PATH}.${Date.now()}.wav`;
            try {
              console.error(`[openclaw-voice-bridge] Recording ${duration}s from ${micDevice}...`);
              await recordAudio(micDevice, duration, wavPath);
              await setSnarlingState("processing");
              console.error(`[openclaw-voice-bridge] Recording complete, transcribing...`);
              const transcript = await transcribeAudio(wavPath, apiKey, transcriptionModel);
              console.error(`[openclaw-voice-bridge] Transcript: "${transcript}"`);
              try {
                appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} Transcript: "${transcript}"
`);
              } catch (_e) {
              }
              try {
                await unlink(wavPath);
              } catch (_e) {
              }
              if (!transcript) {
                console.error("[openclaw-voice-bridge] Empty transcript, nothing to send");
                await setSnarlingState("sleeping");
                isRecording = false;
                return;
              }
              const voiceText = `\u{1F3A4} Voice input: ${transcript}`;
              const sessionKey = "main:main";
              console.error(`[openclaw-voice-bridge] Injecting transcript via TaskFlow wake`);
              try {
                if (api.runtime?.system?.enqueueSystemEvent) {
                  api.runtime.system.enqueueSystemEvent(voiceText, { sessionKey });
                  console.error(`[openclaw-voice-bridge] Enqueued system event`);
                  try {
                    appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} Enqueued: ${voiceText}
`);
                  } catch (_e) {
                  }
                }
                const taskFlowApi = api.runtime?.taskFlow?.bindSession?.({
                  sessionKey,
                  requesterOrigin: "openclaw-voice-bridge"
                }) || api.runtime?.tasks?.flows?.bindSession?.({
                  sessionKey,
                  requesterOrigin: "openclaw-voice-bridge"
                });
                console.error(`[openclaw-voice-bridge] taskFlowApi type: ${typeof taskFlowApi}, keys: ${taskFlowApi ? Object.keys(taskFlowApi).join(",") : "n/a"}`);
                if (taskFlowApi && typeof taskFlowApi.createManaged === "function") {
                  const flow = taskFlowApi.createManaged({
                    controllerId: "openclaw-voice-bridge",
                    goal: voiceText,
                    status: "queued",
                    currentStep: "voice-input"
                  });
                  const flowId = flow?.flowId || flow?.id;
                  const flowRev = flow?.revision ?? 0;
                  console.error(`[openclaw-voice-bridge] Created TaskFlow flowId=${flowId} rev=${flowRev}`);
                  const waiting = taskFlowApi.setWaiting({
                    flowId,
                    expectedRevision: flowRev,
                    currentStep: "voice-input",
                    waitJson: { transcript }
                  });
                  console.error(`[openclaw-voice-bridge] setWaiting result: applied=${waiting?.applied}, flowRev=${waiting?.flow?.revision}`);
                  if (waiting?.applied) {
                    const resumed = taskFlowApi.resume({
                      flowId,
                      expectedRevision: waiting.flow.revision,
                      status: "running",
                      currentStep: "voice-input",
                      stateJson: { transcript, voiceText }
                    });
                    console.error(`[openclaw-voice-bridge] resume result: applied=${resumed?.applied}`);
                    if (resumed?.applied) {
                      taskFlowApi.finish({
                        flowId,
                        expectedRevision: resumed.flow.revision,
                        stateJson: { transcript, voiceText }
                      });
                      console.error(`[openclaw-voice-bridge] TaskFlow finished`);
                    }
                  }
                } else {
                  console.error(`[openclaw-voice-bridge] TaskFlow createManaged not available`);
                }
                try {
                  api.runtime?.system?.requestHeartbeatNow?.({ reason: "voice-input", sessionKey, coalesceMs: 0 });
                  console.error(`[openclaw-voice-bridge] requestHeartbeatNow called`);
                } catch (_e) {
                }
                try {
                  api.runtime?.system?.runHeartbeatOnce?.({ sessionKey, reason: "voice-input", heartbeat: { target: "last" } });
                  console.error(`[openclaw-voice-bridge] runHeartbeatOnce called`);
                } catch (_e) {
                }
                try {
                  const http = await import("http");
                  http.get("http://localhost:18789/api/heartbeat/trigger?sessionKey=" + encodeURIComponent(sessionKey) + "&reason=voice-input", (res2) => {
                    let body2 = "";
                    res2.on("data", (chunk) => body2 += chunk);
                    res2.on("end", () => {
                      console.error(`[openclaw-voice-bridge] HTTP wake response: ${res2.statusCode} ${body2.slice(0, 100)}`);
                    });
                  }).on("error", (e) => {
                    console.error(`[openclaw-voice-bridge] HTTP wake error: ${e.message}`);
                  });
                } catch (_e) {
                }
              } catch (err) {
                console.error(`[openclaw-voice-bridge] Wake error: ${err?.message || err}`);
                try {
                  if (api.runtime?.system?.enqueueSystemEvent) {
                    api.runtime.system.enqueueSystemEvent(voiceText, { sessionKey });
                  }
                } catch (_e) {
                }
              }
              setSnarlingState("sleeping").catch(() => {
              });
              isRecording = false;
            } catch (err) {
              console.error(`[openclaw-voice-bridge] Error: ${err instanceof Error ? err.message : String(err)}`);
              try {
                await unlink(wavPath);
              } catch (_e) {
              }
              await setSnarlingState("sleeping");
              isRecording = false;
            }
          })();
          return true;
        }
      });
      console.error("[openclaw-voice-bridge] Registered /start-listening route");
      api.registerHttpRoute({
        method: "GET",
        path: "/audio-status",
        auth: "gateway",
        match: "exact",
        replaceExisting: true,
        handler: async (_req, res) => {
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
    api.registerTool((ctx) => {
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
        async execute(_toolCallId, params) {
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
            try {
              await unlink(wavPath);
            } catch (_e) {
            }
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
export {
  index_default as default
};
