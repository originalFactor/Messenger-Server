import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const cache = new Map();
let authenticated = true;
let limited = false;
let outgoing = [];
let respond = () => Response.json({ data: [] });
const mocks = {
  "@/lib/auth": { requireUserSession: async () => authenticated ? { sub: "test-user" } : null },
  "@/lib/rate-limit": { enforceRateLimits: async () => limited ? new Response(null, { status: 429 }) : null },
  "@/lib/http": {
    jsonOk: (data, status = 200, headers) => Response.json(data, { status, headers }),
    jsonError: (error, status) => Response.json({ error }, { status }),
  },
};
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const source = ts.transpileModule(readFileSync(join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const testModule = { exports: {} };
  runInNewContext(source, {
    module: testModule, exports: testModule.exports, crypto, URL, AbortSignal, Buffer, Response,
    fetch: async (url, options) => { outgoing.push({ url, options }); return respond(url, options); },
    require(name) {
      if (mocks[name]) return mocks[name];
      if (name.startsWith("@/")) {
        const target = name.slice(2);
        return load(existsSync(join(root, `${target}.ts`)) ? `${target}.ts` : `${target}/index.ts`);
      }
      if (name.startsWith(".") && name.endsWith(".json")) return JSON.parse(readFileSync(join(root, dirname(file), name), "utf8"));
      return require(name);
    },
  });
  cache.set(file, testModule.exports);
  return testModule.exports;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const { parseProviderModels } = load("lib/provider-models.ts");
const { mergeProviderModels, applyProviderModelMetadata, preserveProviderModelFields } = load("lib/provider-model-metadata.ts");
const { providerSchema } = load("lib/validation.ts");
const extended = {
  id: "vendor/model", display_name: "Model Alpha", context_window: 1_000_000, max_output_tokens: 32_000,
  input_modalities: ["text", "image"], reasoning: true, reasoning_efforts: ["none", "high"],
  supports_temperature: false, supports_top_p: false, supports_penalties: false,
  input_rate: 0, cache_read_rate: 0, cache_write_rate: 0.1, output_rate: 1,
  tiers: [{ input_tokens_above: 100_000, input_tokens_above_inclusive: true, input_rate: 0 }],
  time_based: { off_peak_multiplier: 0.5, peak_windows: [{ weekdays: [1], start_minute: 0, end_minute: 1440 }] },
};
const models = parseProviderModels({ data: [extended, { id: "plain" }, extended, null, { id: "" }] });
assert.equal(models.length, 2);
assert.equal(models[0].inputRate, 0);
assert.equal(models[0].cacheReadRate, 0);
assert.equal(models[0].metadata.supportsTemperature, false);
assert.equal(models[0].metadata.contextWindow, 1_000_000);
assert.equal(models[0].tiers[0].inputThresholdInclusive, true);
assert.equal(models[0].tiers[0].inputRate, 0);
assert.equal(models[0].timeBased.peakWindows[0].startMinute, 0);
assert.ok(!models[1].metadata);
assert.ok(providerSchema.safeParse({ id: crypto.randomUUID(), name: "Test", baseUrl: "https://example.com/v1", apiKey: "test", models, createdAt: 0, updatedAt: 0 }).success);
assert.equal(parseProviderModels({ models: [{ name: "models/gemini-test" }] })[0].modelId, "gemini-test");
assert.equal(parseProviderModels({ data: [{ id: "anthropic", display_name: "Anthropic model" }] })[0].displayName, "Anthropic model");
const sparse = parseProviderModels({ data: [{ id: "sparse", metadata: { supportsTemperature: false, reasoningEfforts: [] }, context_window: -1, input_rate: "bad" }] })[0];
assert.equal(sparse.metadata.supportsTemperature, false);
assert.equal(sparse.contextWindow, undefined);
assert.equal(sparse.inputRate, undefined);
assert.throws(() => parseProviderModels({ error: "bad" }));
const original = { ...models[0], displayName: "My custom name", isEnabled: false };
const manual = { ...models[1], modelId: "manual" };
const merged = mergeProviderModels([original, manual], models);
assert.equal(merged.length, 3);
assert.equal(merged[0].id, original.id);
assert.equal(merged[0].displayName, "My custom name");
assert.equal(merged[0].isEnabled, false);
assert.equal(merged[1].modelId, "manual");
const [legacy] = preserveProviderModelFields([{ id: original.id, modelId: original.modelId, displayName: "Native edit", isEnabled: true, createdAt: 0 }], [original]);
assert.deepEqual(plain(legacy.metadata), plain(original.metadata));
assert.equal(legacy.cacheReadRate, 0);
assert.equal(preserveProviderModelFields([{ ...legacy, metadata: null }], [original])[0].metadata, null);
assert.equal(preserveProviderModelFields([{ id: original.id, modelId: "changed", displayName: "", isEnabled: true, createdAt: 0 }], [original])[0].metadata, undefined);
const catalog = { contextWindow: 500, maxOutputTokens: 20, inputModalities: ["text"], reasoning: true, reasoningEfforts: ["low"], supportsTemperature: true, supportsTopP: true, supportsPenalties: true, defaultReasoningEffort: "low", displayName: "Catalog" };
const effective = applyProviderModelMetadata(catalog, original);
assert.equal(effective.supportsTemperature, false);
assert.equal(effective.contextWindow, 1_000_000);
assert.deepEqual(plain(effective.reasoningEfforts), ["none", "high"]);
assert.equal(effective.defaultReasoningEffort, null);
assert.deepEqual(plain(applyProviderModelMetadata(catalog, { ...original, metadata: { reasoning: false } }).reasoningEfforts), []);
assert.equal(applyProviderModelMetadata(catalog, sparse).maxOutputTokens, 20);

const { samplingRequestFields } = load("lib/sampling.ts");
assert.deepEqual(plain(samplingRequestFields({ temperature: 0, topP: 1, frequencyPenalty: 0, presencePenalty: 1 }, undefined, effective)), {});
assert.equal(samplingRequestFields({ temperature: 0 }, undefined, applyProviderModelMetadata(catalog, sparse)).temperature, undefined);

const { POST } = load("app/api/providers/probe/route.ts");
const request = (body = {}) => new Request("http://localhost/api/providers/probe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ baseUrl: "https://example.com/v1/", apiKey: "test-secret", apiFormat: "chat", ...body }) });
authenticated = false;
assert.equal((await POST(request())).status, 401);
assert.equal(outgoing.length, 0);
authenticated = true;
limited = true;
assert.equal((await POST(request())).status, 429);
assert.equal(outgoing.length, 0);
limited = false;
assert.equal((await POST(request({ baseUrl: "file:///tmp/models" }))).status, 400);
assert.equal(outgoing.length, 0);
respond = () => Response.json({ data: [extended] });
const response = await POST(request({ apiFormat: "messages" }));
assert.equal(response.status, 200);
assert.equal(outgoing[0].url, "https://example.com/v1/models");
assert.equal(outgoing[0].options.redirect, "error");
assert.equal(outgoing[0].options.headers["x-api-key"], "test-secret");
assert.equal(response.headers.get("Cache-Control"), "private, no-store");
assert.ok(!(await response.text()).includes("test-secret"));
outgoing = [];
respond = (url) => new URL(url).searchParams.has("after_id") ? Response.json({ data: [{ id: "second" }] }) : Response.json({ data: [{ id: "first" }], has_more: true, last_id: "first" });
const paged = await (await POST(request())).json();
assert.equal(paged.models.length, 2);
assert.equal(outgoing.length, 2);
assert.equal(new URL(outgoing[1].url).searchParams.get("after_id"), "first");
outgoing = [];
respond = () => new Response("not authorized", { status: 401 });
assert.equal((await POST(request())).status, 502);
assert.equal(outgoing.length, 1, "Upstream failures must never retry silently");
respond = () => Response.json({ data: [], has_more: true, last_id: "loop" });
assert.equal((await POST(request())).status, 502);
respond = () => Response.json({ data: [], has_more: true });
assert.equal((await POST(request())).status, 502);
respond = () => new Response("bad json");
assert.equal((await POST(request())).status, 502);
respond = () => new Response("x".repeat(8 * 1024 * 1024 + 1));
assert.equal((await POST(request())).status, 502);
console.log("Provider discovery checks passed: standard/extended lists, zero/false values, sparse metadata, pricing, merge/legacy preservation, effective capabilities, auth, protocol headers, pagination, bounds and visible failures without retries.");
