// OpenCode backend — talks to OpenCode's HTTP API directly.
//
// Two API generations are supported and auto-detected at startup (see Backend#detect):
//
//   v2  OpenCode Desktop / CLI >= 2.x   JSON routes under /api/*   (/api/model, /api/session, ...)
//   v1  opencode serve <= 1.x           JSON routes at the root    (/provider,  /session,  ...)
//
// One implementation therefore works against whichever `opencode` binary is installed, with
// NO wrapper executable and NO v1->v2 translation shim in between.

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";

const exec = promisify(execFile);

export function isWindows() {
  return process.platform === "win32";
}

function binaryName() {
  return isWindows() ? "opencode.exe" : "opencode";
}

/**
 * Candidate locations for an existing OpenCode install, in priority order.
 * `OPENCODE_BIN` (written by the plugin settings card) overrides everything.
 */
export function runtimeCandidates(env = process.env, home = os.homedir()) {
  const p = isWindows() ? path.win32 : path.posix;
  const local = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
  const roaming = env.APPDATA || p.join(home, "AppData", "Roaming");
  const installed = isWindows()
    ? [
        p.join(home, ".opencode", "bin", binaryName()),
        p.join(local, "Programs", "@opencodedesktop", "resources", "opencode-cli.exe"),
        p.join(local, "opencode", "opencode-cli.exe"),
        p.join(roaming, "npm", "node_modules", "opencode-ai", "bin", binaryName()),
      ]
    : [
        p.join(home, ".opencode", "bin", binaryName()),
        "/opt/homebrew/bin/opencode",
        "/usr/local/bin/opencode",
      ];
  return [env.OPENCODE_BIN, ...installed].filter(Boolean);
}

/** Pick the first candidate that reports a version. Returns the file path or null. */
export async function findRuntime(candidates = runtimeCandidates()) {
  for (const file of candidates) {
    if (typeof file !== "string" || /\.(?:cmd|bat|ps1)$/i.test(file)) continue;
    try {
      // Accept "1.2.3", "opencode v1.2.3" and "opencode 1.2.3": some builds prefix the
      // binary name, which previously made a strict ^\d check reject a perfectly good CLI.
      const out = (await exec(file, ["--version"], { timeout: 15000, windowsHide: true })).stdout.trim();
      if (/\d+\.\d+\.\d+/.test(out)) return file;
    } catch {}
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const n = s.address().port;
      s.close(() => resolve(n));
    });
  });
}

// Every native tool is denied: DSH owns execution, the model only reasons.
const NATIVE_PERMISSIONS = {
  "*": "ask",
  question: "deny",
  websearch: "deny",
  codesearch: "deny",
  webfetch: "deny",
  task: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
  todowrite: "deny",
};

const ISOLATED_CONFIG = {
  permission: NATIVE_PERMISSIONS,
  autoupdate: false,
  share: "disabled",
  agent: {
    "buddy-chat": {
      mode: "primary",
      description: "Text-only external conversation",
      prompt: "Reply in plain text to the external conversation. No tool use or local actions. Never claim to have executed an action.",
      permission: NATIVE_PERMISSIONS,
    },
    "buddy-bridge": {
      mode: "primary",
      description: "External client inference only",
      prompt: "You are the reasoning component of an external assistant. Never invoke native OpenCode tools. Describe external tool calls only in the requested JSON response. The external client owns execution and supplies tool results on the next request.",
      permission: NATIVE_PERMISSIONS,
    },
  },
};

/**
 * Launch an isolated OpenCode server. Returns { backend, stop, version }.
 * `dataDir` is where the isolated XDG home is created (a writable plugin/data dir).
 */
export async function startBackend(binary, dataDir, log = () => {}) {
  const reported = (await exec(binary, ["--version"], { timeout: 15000, windowsHide: true })).stdout.trim();
  const home = os.homedir();
  const root = path.join(dataDir, "opencode");
  for (const d of ["config", "data", "cache", "state", "project"]) {
    mkdirSync(path.join(root, d), { recursive: true, mode: 0o700 });
  }

  const env = {};
  for (const k of [
    "PATH", "HOME", "USER", "LANG", "TMPDIR", "SHELL", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
    "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT", "COMSPEC",
  ]) if (process.env[k]) env[k] = process.env[k];
  for (const name of ["config", "data", "cache", "state"]) {
    env[`XDG_${name.toUpperCase()}_HOME`] = path.join(root, name);
  }

  // Seed the isolated XDG tree from the user's real OpenCode install so custom providers and
  // their credentials keep working here too. Files are copied in, never modified.
  const seedFrom = [
    [path.join(home, ".config", "opencode", "opencode.json"), path.join(root, "config", "opencode", "opencode.json")],
    [path.join(home, ".config", "opencode", "opencode.jsonc"), path.join(root, "config", "opencode", "opencode.jsonc")],
    [path.join(home, ".local", "share", "opencode", "auth.json"), path.join(root, "data", "opencode", "auth.json")],
  ];
  for (const [src, dst] of seedFrom) {
    try {
      if (!existsSync(src)) continue;
      mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      copyFileSync(src, dst);
      try { chmodSync(dst, 0o600); } catch {}
      log(`seeded ${path.basename(src)} into isolated ${path.relative(root, path.dirname(dst))}`);
    } catch (e) {
      log(`seed ${path.basename(src)} failed: ${String(e.message || e).slice(0, 120)}`);
    }
  }

  const password = randomBytes(24).toString("hex");
  Object.assign(env, {
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify(ISOLATED_CONFIG),
  });

  const port = await freePort();
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(root, "project"),
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log(`[opencode] ${d.toString().trim()}`));
  child.stderr.on("data", (d) => log(`[opencode:err] ${d.toString().trim()}`));
  let failure;
  child.on("error", (e) => { failure = e; });

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 4000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };

  const backend = new Backend(`http://127.0.0.1:${port}`, password, log);
  try {
    // Do not report ready until the server actually answers a real request: the plugin
    // immediately scans the model catalog, and racing that scan against a cold server is
    // exactly what produced "0 free model(s)" before.
    for (let i = 0; i < 120; i++) {
      if (failure || child.exitCode !== null) throw failure || new Error(`OpenCode exited: ${child.exitCode}`);
      const probe = await backend.detect().catch(() => null);
      if (probe) return { backend, stop, version: probe.version || reported };
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("OpenCode startup timed out");
  } catch (e) {
    await stop();
    throw e;
  }
}

/** Minimal OpenCode HTTP client (HTTP Basic auth), speaking v1 or v2 as detected. */
export class Backend {
  constructor(base, password, log = () => {}) {
    Object.assign(this, { base, password, log, flavor: null, version: null });
  }

  headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
    };
  }

  async request(route, method = "GET", body, signal, timeout = 20000) {
    const res = await fetch(this.base + route, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: timeout == null ? signal : AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    }).catch((e) => {
      throw Object.assign(new Error(`OpenCode request failed: ${e.message}`), { status: 502, code: "upstream_error" });
    });
    const text = await res.text();
    if (!res.ok) {
      throw Object.assign(new Error(`OpenCode HTTP ${res.status}: ${text.slice(0, 600)}`), {
        status: res.status >= 500 ? 502 : res.status,
        code: "upstream_error",
      });
    }
    // Several v2 endpoints answer 204 No Content (set model / set agent / delete session);
    // JSON.parse("") would throw, so treat an empty body as "no payload".
    if (!text || text.trim() === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error("OpenCode returned non-JSON response"), { status: 502, code: "upstream_error" });
    }
  }

  /** Detect which API generation is listening. Cached. Returns { flavor, version } or null. */
  async detect() {
    if (this.flavor) return { flavor: this.flavor, version: this.version };
    // v2 serves its JSON catalog under /api/*; v1 has no /api/model (it would 404 or return HTML).
    try {
      const probe = await fetch(this.base + "/api/model", {
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (probe.ok && (probe.headers.get("content-type") || "").includes("application/json")) {
        const info = await this.request("/api/info", "GET", undefined, undefined, 5000).catch(() => null);
        this.flavor = "v2";
        this.version = info?.version ?? "2.x";
        return { flavor: this.flavor, version: this.version };
      }
    } catch {}
    const health = await this.request("/global/health", "GET", undefined, undefined, 3000).catch(() => null);
    if (health && health.healthy) {
      this.flavor = "v1";
      this.version = health.version ?? "1.x";
      return { flavor: this.flavor, version: this.version };
    }
    return null;
  }

  /** The OpenCode provider catalog, normalised to the v1 { all, default, connected } shape. */
  async providers() {
    await this.detect();
    if (this.flavor === "v2") return this.v2Providers();
    return this.request("/provider");
  }

  async v2Providers() {
    const rows = [];
    let cursor = null;
    for (let i = 0; i < 100; i++) {
      const page = await this.request(`/api/model${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      const data = Array.isArray(page?.data) ? page.data : Array.isArray(page) ? page : [];
      rows.push(...data);
      cursor = page?.cursor ?? null;
      if (!cursor) break;
    }
    const byProvider = new Map();
    for (const m of rows) {
      const full = String(m?.id ?? "");
      const providerID = m?.providerID ?? (full.includes("/") ? full.split("/")[0] : "");
      const modelID = m?.modelID ?? (full.includes("/") ? full.split("/").slice(1).join("/") : full);
      if (!providerID || !modelID) continue;
      if (!byProvider.has(providerID)) byProvider.set(providerID, { id: providerID, models: {} });
      const c = Array.isArray(m.cost) ? (m.cost[0] ?? {}) : (m.cost ?? {});
      const inputCaps = m.capabilities?.input;
      byProvider.get(providerID).models[modelID] = {
        name: m.name || modelID,
        cost: { input: c.input ?? 0, output: c.output ?? 0, cache: { read: c.cache?.read ?? 0, write: c.cache?.write ?? 0 } },
        limit: { context: m.limit?.context, input: m.limit?.input, output: m.limit?.output },
        capabilities: {
          output: { text: true },
          input: { image: Array.isArray(inputCaps) ? inputCaps.includes("image") : inputCaps?.image === true },
          toolcall: m.capabilities?.tools === true || m.capabilities?.toolcall === true,
          reasoning: m.capabilities?.reasoning === true,
        },
        status: m.status,
        variants: m.variants ?? {},
      };
    }
    const all = [...byProvider.values()];
    // Everything the v2 catalog returns is already tied to a configured provider, so treat
    // all of them as connected — otherwise the free-model filter would drop every model.
    return { all, default: {}, connected: all.map((p) => p.id) };
  }

  /** One bounded chat turn, delegating to the matching API generation. */
  async complete(request, signal) {
    await this.detect();
    if (this.flavor === "v2") return this.v2Complete(request, signal);
    return this.v1Complete(request, signal);
  }

  // ---- v1 (opencode serve <= 1.x) ---------------------------------------

  async v1Complete(request, signal) {
    const session = await this.request(
      "/session",
      "POST",
      {
        title: "dsh-connect-opencode",
        permission: Object.entries(NATIVE_PERMISSIONS).map(([permission, action]) => ({ permission, pattern: "*", action })),
      },
      signal,
    );
    const route = `/session/${encodeURIComponent(session.id)}`;
    let successful = false;
    try {
      const callsSchema = {
        type: "array",
        ...(request.parallel ? {} : { maxItems: 1 }),
        ...(request.choice === "required" || request.forced ? { minItems: 1 } : {}),
        ...(request.tools.length
          ? {
              items: {
                anyOf: request.tools.map(({ function: tool }) => ({
                  type: "object",
                  properties: { name: { type: "string", const: tool.name }, arguments: tool.parameters || { type: "object" } },
                  required: ["name", "arguments"],
                  additionalProperties: false,
                })),
              },
            }
          : { maxItems: 0, items: { type: "object" } }),
      };
      const [providerID, ...rest] = String(request.model.id).split("/");
      const payload = {
        model: { providerID, modelID: rest.join("/") },
        ...(request.variant ? { variant: request.variant } : {}),
        agent: request.chatOnly ? "buddy-chat" : "buddy-bridge",
        system: request.chatOnly
          ? request.system
          : request.system + "\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.",
        ...(request.chatOnly
          ? {}
          : {
              format: {
                type: "json_schema",
                retryCount: 0,
                schema: {
                  type: "object",
                  properties: { content: { type: "string" }, calls: callsSchema },
                  required: ["content", "calls"],
                  additionalProperties: false,
                },
              },
            }),
        parts: [{ type: "text", text: request.text }, ...(request.images ?? [])],
      };
      const response = await this.request(`${route}/message`, "POST", payload, signal, null);
      if (response.info?.error && (request.chatOnly || response.info.error.name !== "StructuredOutputError")) {
        const error = response.info.error;
        throw Object.assign(new Error(error.data?.message || error.message || error.name || "Model request failed"), {
          status: error.data?.statusCode || 502,
          code: "model_error",
        });
      }
      if (response.parts?.some((p) => p.type === "tool" && (request.chatOnly || !["StructuredOutput", "invalid"].includes(p.tool)))) {
        throw Object.assign(new Error("Unexpected native tool activity; response rejected"), { status: 502, code: "native_tool_activity" });
      }
      const structuredPart = (response.parts || []).find(
        (p) => p.type === "tool" && p.tool === "StructuredOutput" && p.state?.status === "completed" && p.state?.input,
      );
      const envelope = response.info?.structured ?? structuredPart?.state?.input;
      const text =
        envelope !== undefined
          ? JSON.stringify(envelope)
          : (response.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("");
      if (response.info?.finish === "length") throw Object.assign(new Error("Model output was truncated"), { status: 502, code: "output_truncated" });
      if (!text.trim()) throw Object.assign(new Error("Model returned no text"), { status: 502, code: "invalid_model_output" });
      successful = true;
      return { text, tokens: response.info?.tokens };
    } finally {
      if (!successful) await this.request(`${route}/abort`, "POST", undefined, undefined, 5000).catch(() => {});
      await this.request(route, "DELETE", undefined, undefined, 5000).catch(() => {});
    }
  }

  // ---- v2 (OpenCode Desktop / CLI >= 2.x) -------------------------------

  async v2Complete(request, signal) {
    const created = await this.request("/api/session", "POST", { title: "dsh-connect-opencode" }, signal, 30000);
    const sessionID = created?.data?.id ?? created?.id;
    if (!sessionID) throw Object.assign(new Error("OpenCode v2 did not return a session id"), { status: 502, code: "upstream_error" });
    const sid = encodeURIComponent(sessionID);
    let successful = false;
    try {
      const [providerID, ...rest] = String(request.model.id).split("/");
      const modelID = rest.join("/");
      if (providerID && modelID) {
        await this.request(`/api/session/${sid}/model`, "POST", { model: { providerID, id: modelID } }, signal, 20000).catch((e) =>
          this.log(`set model failed: ${e.message}`),
        );
      }
      const agent = request.chatOnly ? "buddy-chat" : "buddy-bridge";
      await this.request(`/api/session/${sid}/agent`, "POST", { agent }, signal, 20000).catch(() => {});

      // v2's /prompt has no `system` or `format` field, so the system prompt (which already
      // carries the structured-output instruction) is folded into the message text.
      const system = request.chatOnly
        ? request.system
        : `${request.system}\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.`;
      const composed = system ? `${system}\n\n${request.text}` : request.text;
      await this.request(`/api/session/${sid}/prompt`, "POST", { text: composed }, signal, 120000);

      const assistant = await this.pollAssistantV2(sid, signal);
      if (assistant.finish === "length") {
        throw Object.assign(new Error("Model output was truncated"), { status: 502, code: "output_truncated" });
      }
      const text = this.envelopeText(
        (assistant.content ?? [])
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join(""),
      );
      if (!text.trim()) throw Object.assign(new Error("Model returned no text"), { status: 502, code: "invalid_model_output" });
      successful = true;
      return { text, tokens: assistant.tokens };
    } finally {
      if (!successful) await this.request(`/api/session/${sid}/interrupt`, "POST", undefined, undefined, 5000).catch(() => {});
      await this.request(`/api/session/${sid}`, "DELETE", undefined, undefined, 5000).catch(() => {});
    }
  }

  /** Normalise a raw assistant reply so protocol.js always sees a {content,calls} envelope. */
  envelopeText(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("```")) {
      try {
        const json = JSON.parse(trimmed.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1"));
        if (json && typeof json === "object" && "content" in json && "calls" in json) return JSON.stringify(json);
      } catch {}
    }
    return raw;
  }

  async pollAssistantV2(sid, signal) {
    for (let i = 0; i < 240; i++) {
      if (signal?.aborted) throw Object.assign(new Error("Model request aborted"), { status: 499, code: "aborted" });
      const page = await this.request(`/api/session/${sid}/message`, "GET", undefined, signal, 30000).catch(() => null);
      const list = Array.isArray(page?.data) ? page.data : [];
      const assistant = list.find((m) => m?.type === "assistant");
      if (assistant?.time?.completed) return assistant;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw Object.assign(new Error("OpenCode v2 produced no assistant message"), { status: 502, code: "upstream_error" });
  }
}
