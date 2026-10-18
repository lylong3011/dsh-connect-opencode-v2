#!/usr/bin/env node
// dsh-connect-opencode CLI — run OUTSIDE the DSH sandbox to validate against your real OpenCode.
// Subcommands: doctor | models | probe | chat "<prompt>" [--model <id>]
import { findRuntime, startBackend } from "../lib/backend.js";
import { freeModels, modelEntry } from "../lib/catalog.js";
import { createShim } from "../lib/shim.js";
import { prepare, decode } from "../lib/protocol.js";
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

const dataDir = path.join(homedir(), ".dsh", "connect-opencode-v2");
fs.mkdirSync(dataDir, { recursive: true });

const [cmd = "doctor", ...rest] = process.argv.slice(2);

function arg(name) { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; }

async function withBackend(fn) {
  const binary = process.env.OPENCODE_BIN ? (fs.existsSync(process.env.OPENCODE_BIN) ? process.env.OPENCODE_BIN : null) : await findRuntime();
  if (!binary) { console.error("opencode executable not found. Set OPENCODE_BIN or install opencode (npm i -g opencode-ai)."); process.exit(2); }
  console.log(`binary: ${binary}`);
  let started;
  try { started = await startBackend(binary, dataDir, (m) => console.error(m)); }
  catch (e) { console.error("failed to start opencode serve:", e.message); process.exit(3); }
  console.log(`opencode serve ready (v${started.version}) at ${started.backend.base}`);
  try { return await fn(started); }
  finally { await started.stop(); }
}

if (cmd === "doctor") {
  const binary = process.env.OPENCODE_BIN || await findRuntime();
  console.log(binary ? `ok: ${binary}` : "missing: opencode not found");
}
else if (cmd === "models") {
  await withBackend(async ({ backend }) => {
    const models = freeModels(await backend.providers()).map(modelEntry);
    if (!models.length) console.log("No free (cost=0) models in OpenCode. Configure a provider with free models first.");
    for (const m of models) console.log(`  ${m.id}  ctx=${m.contextWindow} out=${m.maxTokens} img=${m.inputModalities.includes("image")} tool=${!m.chatOnly}`);
  });
}
else if (cmd === "probe") {
  // Definitive "is this model actually usable here?" check: one tiny real request per model.
  // This is what to run when DSH shows a pile of models that all fail.
  const limitMs = Number(arg("--timeout") ?? 25000);
  await withBackend(async ({ backend }) => {
    const models = freeModels(await backend.providers()).map(modelEntry);
    if (!models.length) {
      console.log("No free (cost=0) models listed. Check that OpenCode has an active provider:");
      console.log("  /api/provider should list at least one provider.");
      return;
    }
    console.log(`\nprobing ${models.length} model(s), ${limitMs} ms timeout each...\n`);
    const results = [];
    for (const m of models) {
      const started = Date.now();
      try {
        const request = prepare({ model: m.id, messages: [{ role: "user", content: "ping" }] }, models);
        const { text } = await backend.complete(request, AbortSignal.timeout(limitMs));
        const message = request.chatOnly ? { content: text } : decode(text, request);
        const ms = Date.now() - started;
        const answer = (message.content ?? "").replace(/\s+/g, " ").slice(0, 40);
        results.push({ id: m.id, ok: true, ms });
        console.log(`  OK    ${m.id.padEnd(46)} ${String(ms).padStart(6)} ms  ${JSON.stringify(answer)}`);
      } catch (e) {
        const ms = Date.now() - started;
        results.push({ id: m.id, ok: false, ms, error: e.message });
        console.log(`  FAIL  ${m.id.padEnd(46)} ${String(ms).padStart(6)} ms  ${String(e.message).replace(/\s+/g, " ").slice(0, 110)}`);
      }
    }
    const ok = results.filter((r) => r.ok);
    console.log(`\n${ok.length}/${results.length} model(s) usable here.`);
    if (!ok.length) {
      console.log("\nAll models failed. Typical causes:");
      console.log("  - this network/region is blocked by the upstream (look for 403 / RegionError)");
      console.log("  - OpenCode has no valid credentials (run `opencode auth list`)");
      console.log("  - the free models in your catalog are not offered to your account");
    }
    process.exit(ok.length ? 0 : 6);
  });
}
else if (cmd === "chat") {
  const prompt = rest.find((r) => !r.startsWith("--")) ?? "Reply with exactly: pong";
  const modelId = arg("--model");
  await withBackend(async ({ backend }) => {
    const models = freeModels(await backend.providers()).map(modelEntry);
    if (!models.length) { console.error("no free models"); process.exit(4); }
    const chosen = (modelId ? models.find((m) => m.id === modelId) : models[0]) ?? models[0];
    console.log(`using ${chosen.id}`);
    const shim = createShim({ getModels: () => models, complete: (r, s) => backend.complete(r, s) });
    await shim.ready;
    const body = { model: chosen.id, messages: [{ role: "user", content: prompt }] };
    const res = await fetch(shim.baseUrl() + "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${shim.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    if (out.error) { console.error("error:", out.error.message || out.error); await shim.close(); process.exit(5); }
    console.log("answer:", out.choices?.[0]?.message?.content);
    console.log("usage:", JSON.stringify(out.usage));
    await shim.close();
  });
}
else {
  console.log("usage: dsh-connect-opencode [doctor|models|probe|chat] [args]");
  console.log("  doctor                 locate the opencode executable");
  console.log("  models                 list free (cost=0) models in the isolated serve");
  console.log("  probe [--timeout ms]   really call each listed model and report which work");
  console.log('  chat "prompt" [--model id]  run one turn end to end');
}
