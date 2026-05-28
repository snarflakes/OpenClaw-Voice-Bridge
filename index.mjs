import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { readFile } from "fs/promises";
import { appendFileSync } from "fs";
import { randomUUID } from "crypto";
const SNARLING_URL = "http://localhost:5000/state";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
let cachedApiKey = null;
async function setSnarlingState(state) {
  try {
    const http = await import("http");
    await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ state });
      const req = http.request({
        hostname: "localhost",
        port: 5e3,
        path: "/state",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      }, (res) => {
        res.on("data", () => {
        });
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  } catch (_e) {
  }
}
async function resolveOpenAIKey(runtime) {
  if (cachedApiKey) return cachedApiKey;
  if (runtime?.modelAuth?.resolveApiKeyForProvider) {
    try {
      const auth = await runtime.modelAuth.resolveApiKeyForProvider({ provider: "openai" });
      if (auth?.apiKey) {
        cachedApiKey = auth.apiKey;
        console.info(`[openclaw-voice-bridge] Resolved OpenAI key via modelAuth (source: ${auth.source || "unknown"})`);
        try {
          appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} Resolved key via modelAuth (source: ${auth.source || "unknown"})
`);
        } catch (_e) {
        }
        return auth.apiKey;
      }
    } catch (e) {
      console.error(`[openclaw-voice-bridge] modelAuth resolution failed: ${e?.message || String(e)}`);
      try {
        appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} modelAuth failed: ${e?.message || String(e)}
`);
      } catch (_e) {
      }
    }
  }
  try {
    const key = await runtime?.auth?.resolveKey?.("openai:default");
    if (key) {
      cachedApiKey = key;
      console.info(`[openclaw-voice-bridge] Resolved OpenAI key via auth.resolveKey`);
      try {
        appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} Resolved key via auth.resolveKey
`);
      } catch (_e) {
      }
      return key;
    }
  } catch (_e) {
  }
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    cachedApiKey = envKey;
    console.info("[openclaw-voice-bridge] Resolved OpenAI key from process.env");
    try {
      appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} Resolved key from process.env
`);
    } catch (_e) {
    }
    return envKey;
  }
  console.warn("[openclaw-voice-bridge] No OpenAI API key available");
  try {
    appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} No OpenAI key available
`);
  } catch (_e) {
  }
  return null;
}
async function transcribeAudio(audioPath, apiKey, model) {
  const audioBuffer = await readFile(audioPath);
  const boundary = `----FormBoundary${randomUUID().replace(/-/g, "")}`;
  const filename = "recording.wav";
  const parts = [];
  parts.push(Buffer.from(`--${boundary}\r
Content-Disposition: form-data; name="file"; filename="${filename}"\r
Content-Type: audio/wav\r
\r
`));
  parts.push(audioBuffer);
  parts.push(Buffer.from(`\r
--${boundary}\r
Content-Disposition: form-data; name="model"\r
\r
${model}\r
`));
  parts.push(Buffer.from(`--${boundary}\r
Content-Disposition: form-data; name="response_format"\r
\r
text\r
`));
  parts.push(Buffer.from(`--${boundary}--\r
`));
  const body = Buffer.concat(parts);
  return new Promise((resolve, reject) => {
    import("https").then((https) => {
      const req = https.request({
        hostname: "api.openai.com",
        port: 443,
        path: "/v1/audio/transcriptions",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length
        }
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => data += chunk);
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.text || json.error?.message || "");
          } catch {
            resolve(data.trim());
          }
        });
      });
      req.on("error", (e) => reject(new Error(`Transcription request failed: ${e.message}`)));
      req.write(body);
      req.end();
    }).catch((e) => reject(new Error(`Failed to import https: ${e.message}`)));
  });
}
var index_default = definePluginEntry({
  id: "openclaw-voice-bridge",
  name: "OpenClaw Voice Bridge",
  description: "Receives WAV audio paths from snarling, transcribes via OpenAI, and injects transcript into agent session",
  register(api) {
    console.info("[openclaw-voice-bridge] v3 registering, api keys:", Object.keys(api || {}));
    console.info("[openclaw-voice-bridge] api.runtime:", typeof api?.runtime, api?.runtime ? Object.keys(api.runtime) : "null");
    api.registerHttpRoute({
      method: "POST",
      path: "/transcribe-and-reply",
      auth: "gateway",
      match: "exact",
      replaceExisting: true,
      handler: async (req, res) => {
        let body = null;
        try {
          const chunks = [];
          for await (const chunk of req) {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          }
          const raw = Buffer.concat(chunks).toString();
          if (raw) body = JSON.parse(raw);
        } catch (_e) {
        }
        const wavPath = body?.wav_path;
        if (!wavPath) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "wav_path required" }));
          return true;
        }
        try {
          appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} /transcribe-and-reply wav_path=${wavPath}
`);
        } catch (_e) {
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ status: "transcribing" }));
        (async () => {
          try {
            const apiKey = await resolveOpenAIKey(api.runtime);
            try {
              appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} API key resolved: ${apiKey ? apiKey.slice(0, 8) + "..." + apiKey.slice(-4) : "null"}, api.runtime: ${typeof api?.runtime}, api.runtime.auth: ${typeof api?.runtime?.auth}, api.runtime.auth.resolveKey: ${typeof api?.runtime?.auth?.resolveKey}
`);
            } catch (_e) {
            }
            if (!apiKey) {
              console.warn("[openclaw-voice-bridge] No OpenAI API key available");
              try {
                appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} No OpenAI key
`);
              } catch (_e) {
              }
              await setSnarlingState("sleeping");
              return;
            }
            await setSnarlingState("processing");
            try {
              appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} Starting transcription of ${wavPath}
`);
            } catch (_e) {
            }
            const transcript = await transcribeAudio(wavPath, apiKey, DEFAULT_TRANSCRIPTION_MODEL);
            console.info(`[openclaw-voice-bridge] Transcript: "${transcript}"`);
            try {
              appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} Transcript: "${transcript}"
`);
            } catch (_e) {
            }
            if (!transcript) {
              console.info("[openclaw-voice-bridge] Empty transcript, nothing to send");
              await setSnarlingState("sleeping");
              return;
            }
            const voiceText = `\u{1F3A4} Voice input: ${transcript}`;
            const sessionKey = "agent:main:main";
            try {
              const systemApi = api.runtime?.system;
              let usedRuntimeApi = false;
              if (systemApi?.enqueueSystemEvent && systemApi?.runHeartbeatOnce) {
                try {
                  systemApi.enqueueSystemEvent(voiceText, { sessionKey });
                  console.info(`[openclaw-voice-bridge] Enqueued system event via runtime API`);
                  try {
                    appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} Enqueued via runtime API
`);
                  } catch (_e) {
                  }
                } catch (e) {
                  console.error(`[openclaw-voice-bridge] enqueueSystemEvent error: ${e?.message || e}`);
                  try {
                    appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} enqueueSystemEvent error: ${e?.message || e}
`);
                  } catch (_e) {
                  }
                }
                try {
                  setImmediate(() => {
                    try {
                      const wakeReason = "hook:voice_input";
                      if (systemApi?.requestHeartbeatNow) {
                        systemApi.requestHeartbeatNow({
                          reason: wakeReason,
                          sessionKey,
                          coalesceMs: 100
                        });
                      }
                      if (systemApi?.runHeartbeatOnce) {
                        systemApi.runHeartbeatOnce({
                          agentId: "main",
                          sessionKey,
                          reason: wakeReason,
                          heartbeat: { target: "last" }
                        }).then((hbResult) => {
                          console.info(`[openclaw-voice-bridge] runHeartbeatOnce result:`, JSON.stringify(hbResult));
                          try {
                            appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} runHeartbeatOnce result: ${JSON.stringify(hbResult)}
`);
                          } catch (_e) {
                          }
                        }).catch((e) => {
                          console.error(`[openclaw-voice-bridge] runHeartbeatOnce error: ${e?.message || e}`);
                          try {
                            appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} runHeartbeatOnce error: ${e?.message || e}
`);
                          } catch (_e) {
                          }
                        });
                      }
                      setTimeout(() => {
                        try {
                          systemApi?.requestHeartbeatNow?.({
                            reason: wakeReason,
                            sessionKey,
                            coalesceMs: 0
                          });
                        } catch (_e) {
                        }
                      }, 500);
                      try {
                        const hooksToken = process.env.OPENCLAW_HOOKS_TOKEN || "voicebridge-local-hooks-secret";
                        const hooksUrl = `http://127.0.0.1:${process.env.OPENCLAW_PORT || 18789}/hooks/wake`;
                        import("http").then((http) => {
                          const postData = JSON.stringify({ text: `Voice input received: ${transcript}`, mode: "now" });
                          const wakeReq = http.request(hooksUrl, {
                            method: "POST",
                            headers: {
                              "Content-Type": "application/json",
                              "Authorization": `Bearer ${hooksToken}`,
                              "Content-Length": Buffer.byteLength(postData)
                            },
                            timeout: 3e3
                          }, (wakeRes) => {
                            let data = "";
                            wakeRes.on("data", (chunk) => {
                              data += chunk;
                            });
                            wakeRes.on("end", () => {
                              console.info(`[openclaw-voice-bridge] /hooks/wake fallback response: ${wakeRes.statusCode} ${data}`);
                            });
                          });
                          wakeReq.on("error", (e) => {
                            console.warn(`[openclaw-voice-bridge] /hooks/wake fallback failed: ${e.message}`);
                          });
                          wakeReq.write(postData);
                          wakeReq.end();
                        });
                      } catch (_wakeFallbackErr) {
                        console.warn(`[openclaw-voice-bridge] /hooks/wake fallback error: ${_wakeFallbackErr}`);
                      }
                    } catch (_wakeErr) {
                      console.warn(`[openclaw-voice-bridge] Wake cascade error: ${_wakeErr}`);
                    }
                  });
                } catch (e) {
                  console.error(`[openclaw-voice-bridge] Wake cascade setup error: ${e?.message || e}`);
                  try {
                    appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} Wake cascade setup error: ${e?.message || e}
`);
                  } catch (_e) {
                  }
                }
              }
            } catch (err) {
              console.error(`[openclaw-voice-bridge] Wake error: ${err?.message || err}`);
            }
            setSnarlingState("sleeping").catch(() => {
            });
          } catch (err) {
            console.error(`[openclaw-voice-bridge] Error: ${err instanceof Error ? err.message : String(err)}`);
            try {
              appendFileSync("/tmp/voice-bridge-debug.log", `${(/* @__PURE__ */ new Date()).toISOString()} ERROR: ${err instanceof Error ? err.message + " | " + err.stack : String(err)}
`);
            } catch (_e) {
            }
            await setSnarlingState("sleeping");
          }
        })();
        return true;
      }
    });
    console.info("[openclaw-voice-bridge] Registered /transcribe-and-reply route");
    api.registerHttpRoute({
      method: "GET",
      path: "/audio-status",
      auth: "gateway",
      match: "exact",
      replaceExisting: true,
      handler: async (_req, res) => {
        res.statusCode = 200;
        res.end(JSON.stringify({
          version: 3,
          transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
          authAvailable: cachedApiKey ? true : "unknown"
        }));
        return true;
      }
    });
    api.registerHttpRoute({
      method: "POST",
      path: "/start-listening",
      auth: "gateway",
      match: "exact",
      replaceExisting: true,
      handler: async (_req, res) => {
        res.statusCode = 410;
        res.end(JSON.stringify({ error: "Deprecated \u2014 use /transcribe-and-reply with wav_path", hint: "Snarling should record locally and POST wav_path" }));
        return true;
      }
    });
    console.info("[openclaw-voice-bridge] v3 ready");
  }
});
export {
  index_default as default
};
