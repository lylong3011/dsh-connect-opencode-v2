// Local OpenAI-compatible endpoint DSH's pi-ai talks to. Mirrors ow-bridge/server.js but drops the
// admin routes (DSH calls registerModelDiscovery directly) and keeps only /v1/models +
// /v1/chat/completions. Authenticated with a per-process random bearer secret.

import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { prepare, decode, completion, createDeltaFilter, BridgeError } from "./protocol.js";

function authorized(req, key) {
  const actual = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new BridgeError("Request exceeds 8 MB", 413, "payload_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new BridgeError("Invalid JSON"); }
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * @param {(request, signal)=>Promise<{text:string, tokens?:any}>} complete bound to the backend;
 *        `request` is the shaped object from protocol.prepare().
 * @param {()=>any[]} getModels current free-model catalog (each entry has id, chatOnly, images...)
 */
export function createShim({ complete, getModels, log = () => {} }) {
  const token = randomBytes(24).toString("hex");
  const active = new Set();
  const server = createServer(async (req, res) => {
    if (!authorized(req, token)) return json(res, 401, { error: { message: "Local proxy API key required", type: "authentication_error" } });
    if (req.headers.origin) return json(res, 403, { error: { message: "Browser-origin requests are disabled" } });
    const route = new URL(req.url, "http://127.0.0.1").pathname;
    const controller = new AbortController();
    active.add(controller);
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (req.method === "GET" && route === "/health") return json(res, 200, { ok: true });
      if (req.method === "GET" && (route === "/v1/models" || route === "/models"))
        return json(res, 200, { object: "list", data: getModels().map((m) => ({ id: m.id, object: "model", owned_by: "opencode", name: m.displayName ?? m.id })) });
      if (req.method !== "POST" || route !== "/v1/chat/completions") return json(res, 404, { error: { message: "Not found" } });

      const body = await readBody(req);
      const request = prepare(body, getModels()); // validates role/model/tools and shapes the request
      const streaming = Boolean(body.stream);
      log(`turn model=${body.model} stream=${streaming} chatOnly=${request.chatOnly} tools=${request.tools.length}`);
      if (streaming) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });

      // Real incremental streaming: opencode v2 pushes session.text.delta roughly every
      // 100 ms, so the reply can start appearing immediately instead of after the whole
      // generation finishes. The filter hides the bridge envelope and emits only the
      // visible answer text; anything it could not stream is sent by flush() at the end.
      const filter = streaming ? createDeltaFilter({ chatOnly: request.chatOnly }) : null;
      const chunkId = `chatcmpl-${randomUUID()}`;
      const chunkCreated = Math.floor(Date.now() / 1000);
      const writeChunk = (delta, finishReason = null) => {
        res.write(`data: ${JSON.stringify({
          id: chunkId,
          object: "chat.completion.chunk",
          created: chunkCreated,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`);
      };
      if (streaming) writeChunk({ role: "assistant" });

      const { text, tokens } = await complete(request, controller.signal, streaming
        ? (raw) => {
            const visible = filter.push(raw);
            if (visible && !controller.signal.aborted) writeChunk({ content: visible });
          }
        : undefined);
      if (controller.signal.aborted) return;

      const message = request.chatOnly ? { role: "assistant", content: text } : decode(text, request);
      const result = completion(request.model.id, message, tokens ?? {});
      result.model = body.model;

      if (!streaming) return json(res, 200, result);

      // Emit whatever the stream did not already show (short replies, fallback path, or a
      // model whose envelope could not be traced incrementally).
      const remainder = filter.flush(message.content ?? "");
      if (remainder) writeChunk({ content: remainder });
      if (message.tool_calls) writeChunk({ tool_calls: message.tool_calls.map((t, index) => ({ index, ...t })) });
      writeChunk({}, result.choices[0].finish_reason);
      if (body.stream_options?.include_usage && result.usage) {
        res.write(`data: ${JSON.stringify({
          id: chunkId, object: "chat.completion.chunk", created: chunkCreated, model: body.model,
          choices: [], usage: result.usage,
        })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    } catch (e) {
      if (controller.signal.aborted) return;
      const error = { message: e.message, type: e.code || "upstream_error", code: e.code || "upstream_error" };
      if (res.headersSent) res.end(`data: ${JSON.stringify({ error })}\n\n`);
      else json(res, e.status || 502, { error });
    } finally { active.delete(controller); }
  });
  server.requestTimeout = 0; // local inference has no proxy-owned deadline
  server.headersTimeout = 15000;

  return {
    token: () => token,
    close: () => { for (const c of active) c.abort(); server.close(); },
    ready: new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server))),
    baseUrl: () => {
      const a = server.address();
      return a ? `http://127.0.0.1:${a.port}` : "";
    },
    server,
  };
}
