// Unit tests for the pure helpers: model filtering and API-version detection.
// Run with `node --test test/`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { freeModels, modelEntry } from "../lib/catalog.js";

const providers = {
  all: [
    {
      id: "opencode",
      models: {
        "free-a": {
          name: "Free A",
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 200000, input: 200000, output: 32000 },
          capabilities: { output: { text: true }, input: { image: true }, toolcall: true },
        },
        "paid-a": {
          name: "Paid A",
          cost: { input: 1, output: 2 },
          limit: { context: 128000, output: 8192 },
          capabilities: { output: { text: true }, toolcall: true },
        },
        "cache-paid": {
          name: "Cache Paid",
          cost: { input: 0, output: 0, cache: { read: 1, write: 0 } },
          capabilities: { output: { text: true } },
        },
        "no-text": {
          name: "No Text",
          cost: { input: 0, output: 0 },
          capabilities: { output: { text: false } },
        },
        "deprecated-a": {
          name: "Deprecated",
          cost: { input: 0, output: 0 },
          status: "deprecated",
          capabilities: { output: { text: true } },
        },
      },
    },
    {
      id: "disconnected",
      models: {
        "free-b": {
          name: "Free B",
          cost: { input: 0, output: 0 },
          capabilities: { output: { text: true }, toolcall: true },
        },
      },
    },
  ],
  default: {},
  connected: ["opencode"],
};

test("freeModels keeps only zero-cost, connected, text-capable models", () => {
  const ids = freeModels(providers).map((m) => m.id);
  assert.deepEqual(ids, ["opencode/free-a"]);
});

test("freeModels scans everything when `connected` is absent", () => {
  const ids = freeModels({ all: providers.all }).map((m) => m.id);
  assert.deepEqual(ids, ["disconnected/free-b", "opencode/free-a"]);
});

test("modelEntry maps to the DSH catalog shape", () => {
  const entry = modelEntry(freeModels(providers)[0]);
  assert.equal(entry.id, "opencode/free-a");
  assert.equal(entry.displayName, "OC · Free A");
  assert.equal(entry.contextWindow, 200000);
  assert.equal(entry.maxTokens, 32000);
  assert.deepEqual(entry.inputModalities, ["text", "image"]);
  assert.equal(entry.chatOnly, false);
});
