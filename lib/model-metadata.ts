/*
 * Copyright 2026 ECSDevs
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { z } from "zod";

/**
 * models.dev 公开模型元数据：
 * - https://models.dev/models.json：以模型 ID 为键的扁平映射（limit.context
 *   即上下文窗口），用于上下文大小；
 * - https://models.dev/api.json：按供应商嵌套，条目带 cost（每百万 token
 *   的美元成本），用于推导默认输入/输出倍率 —— 以
 *   deepseek/deepseek-v4.1-flash 的成本为基准归一化（其倍率恰为 1.0），
 *   单位在比值中抵消。
 * models.json 里的个别条目 context 为 0，校验放宽并在建映射时跳过。
 * 两个载荷在实例内存中缓存 24 小时；拉取失败回退上一次缓存，永不抛出。
 */

const FLAT_URL = "https://models.dev/models.json";
const API_URL = "https://models.dev/api.json";
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const METADATA_TIMEOUT_MS = 10_000;

/** 倍率基准：deepseek-v4.1-flash（先试官方供应商，再退回裸 ID 查找）。 */
const BASELINE_PROVIDER = "deepseek";
const BASELINE_MODEL = "deepseek-v4.1-flash";

/** 裸 ID 的成本在多家供应商重复出现时，优先采信官方/一线供应商。 */
const CANONICAL_PROVIDERS = new Set([
  BASELINE_PROVIDER,
  "openai",
  "anthropic",
  "google",
  "zhipu",
  "moonshot",
  "moonshotai",
  "alibaba",
  "qwen",
  "minimax",
  "xai",
  "mistral",
  "meta",
  "microsoft",
  "amazon",
]);

const flatModelSchema = z.object({
  limit: z
    .object({
      context: z.number(),
    })
    .partial()
    .optional(),
});

const apiModelSchema = z.object({
  limit: z
    .object({
      context: z.number(),
    })
    .partial()
    .optional(),
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
    })
    .partial()
    .optional(),
});

export interface ModelRates {
  input: number;
  output: number;
}

export type ModelContextSizes = Record<string, number>;
export type ModelRateMap = Record<string, ModelRates>;

interface MetadataCache {
  fetchedAt: number;
  contextSizes: ModelContextSizes;
  rates: ModelRateMap;
}

let cache: MetadataCache | null = null;
let inflight: Promise<MetadataCache> | null = null;

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function fetchMetadata(): Promise<MetadataCache> {
  const [flatPayload, apiPayload] = await Promise.all([
    fetch(FLAT_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`models.json ${response.status}`))))
      .catch(() => null),
    fetch(API_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`api.json ${response.status}`))))
      .catch(() => null),
  ]);

  // —— 上下文：来自扁平 models.json（含 vendor/model → 裸 ID 别名）——
  const contextSizes: ModelContextSizes = {};
  if (flatPayload) {
    const flat = z.record(z.string(), flatModelSchema).safeParse(flatPayload);
    if (flat.success) {
      const entries = flat.data as unknown as Record<string, { limit?: { context?: number } }>;
      for (const [key, model] of Object.entries(entries)) {
        const context = model.limit?.context;
        if (!context || context <= 0) {
          continue;
        }
        contextSizes[key] = Math.max(contextSizes[key] ?? 0, context);
        const separator = key.indexOf("/");
        if (separator > 0) {
          const bareId = key.slice(separator + 1);
          contextSizes[bareId] = Math.max(contextSizes[bareId] ?? 0, context);
        }
      }
    }
  }

  // —— 默认倍率：来自 api.json 的 cost，以基准模型归一化 ——
  const rates: ModelRateMap = {};
  if (apiPayload) {
    const api = z
      .record(z.string(), z.object({ models: z.record(z.string(), apiModelSchema).optional() }))
      .safeParse(apiPayload);
    if (api.success) {
      const providers = api.data as Record<
        string,
        { models?: Record<string, { cost?: { input?: number; output?: number } } | undefined> | undefined }
      >;

      // 两遍扫描：先收集所有有效 cost 条目，再解析基准与裸 ID 别名。
      interface CostEntry {
        provider: string;
        modelId: string;
        input: number;
        output: number;
        canonical: boolean;
      }
      const entries: CostEntry[] = [];
      for (const [providerName, provider] of Object.entries(providers)) {
        for (const [modelId, model] of Object.entries(provider.models ?? {})) {
          if (!model) continue;
          const cost = model.cost;
          if (typeof cost?.input !== "number" || typeof cost?.output !== "number") continue;
          if (cost.input <= 0 || cost.output <= 0) continue;
          entries.push({
            provider: providerName,
            modelId,
            input: cost.input,
            output: cost.output,
            canonical: CANONICAL_PROVIDERS.has(providerName),
          });
        }
      }

      const pickCost = (modelId: string, preferredProvider?: string): ModelRates | null => {
        if (preferredProvider) {
          const direct = entries.find((entry) => entry.modelId === modelId && entry.provider === preferredProvider);
          if (direct) {
            return { input: direct.input, output: direct.output };
          }
        }
        const matches = entries.filter((entry) => entry.modelId === modelId);
        if (matches.length === 0) {
          return null;
        }
        // 一线供应商优先（如 deepseek 官方），否则取输入成本最低的报价。
        const chosen = matches.find((entry) => entry.canonical) ?? matches.reduce((a, b) => (b.input < a.input ? b : a));
        return { input: chosen.input, output: chosen.output };
      };

      // 基准候选链：数据源是活数据，条目会漂移，逐个回退直至命中。
      // 官方 deepseek-v4-flash 与 v4.1-flash 同价，回退不改变基准值。
      let baseline: ModelRates | null = null;
      for (const candidate of [
        BASELINE_MODEL,
        `${BASELINE_PROVIDER}/${BASELINE_MODEL}`,
        "deepseek-v4-flash",
        `${BASELINE_PROVIDER}/deepseek-v4-flash`,
      ]) {
        baseline = pickCost(candidate, candidate.includes("/") ? undefined : BASELINE_PROVIDER);
        if (baseline) {
          break;
        }
      }
      if (baseline) {
        for (const entry of entries) {
          const rate: ModelRates = {
            input: round4(entry.input / baseline.input),
            output: round4(entry.output / baseline.output),
          };
          rates[`${entry.provider}/${entry.modelId}`] = rate;
          const existing = rates[entry.modelId];
          if (!existing) {
            rates[entry.modelId] = rate;
          } else if (entry.canonical || rate.input < existing.input) {
            // 裸 ID 别名：一线供应商覆盖任意报价，非一线之间取更便宜的。
            rates[entry.modelId] = rate;
          }
        }
      }
    }
  }

  return { fetchedAt: Date.now(), contextSizes, rates };
}

export async function getModelDefaults(forceRefresh = false): Promise<MetadataCache> {
  if (!forceRefresh) {
    if (cache && Date.now() - cache.fetchedAt < METADATA_TTL_MS) {
      return cache;
    }
    if (inflight) {
      return inflight;
    }
  }
  inflight = fetchMetadata()
    .then((data) => {
      // models.dev 完全不可达时不缓存空结果，避免一次瞬时故障把
      // 24h 缓存投毒成全空（显示不限/0）；下次请求会重试。
      if (Object.keys(data.contextSizes).length === 0 && Object.keys(data.rates).length === 0) {
        throw new Error("models.dev returned no metadata");
      }
      cache = data;
      return data;
    })
    .catch(() => ({
      fetchedAt: cache?.fetchedAt ?? 0,
      contextSizes: cache?.contextSizes ?? ({} as ModelContextSizes),
      rates: cache?.rates ?? ({} as ModelRateMap),
    }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function getModelContextSizes(): Promise<ModelContextSizes> {
  return (await getModelDefaults()).contextSizes;
}

export async function getModelRates(): Promise<ModelRateMap> {
  return (await getModelDefaults()).rates;
}
