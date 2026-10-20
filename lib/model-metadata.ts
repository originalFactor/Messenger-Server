/*
 * Copyright 2026 originalFactor
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
import { getDb } from "@/lib/mongo";

/**
 * models.dev 公开模型元数据：
 * - https://models.dev/api.json：按供应商嵌套，条目带 cost（每百万 token
 *   的美元成本：input / output / cache_read），用于推导默认输入/输出/缓存
 *   读取倍率 —— 基准为 deepseek/deepseek-v4.1-flash 的峰时输出成本（其
 *   输出倍率恰为 1.0），所有倍率（含 deepseek-v4.1-flash 自身的输入倍率）
 *   都以该基准输出成本为分母折算，单位在比值中抵消。
 * 上下文窗口不再由服务端下发（客户端自行从 models.dev models.json 推导）。
 * 条目缺 cache_read 时按该模型的输入价折算（不收缓存折扣的供应商即如此）。
 * 载荷在实例内存中缓存 24 小时，并每次成功拉取后落库一份快照；拉取失败
 * 时回退内存缓存，冷实例再回退数据库快照，永不抛出。
 */

const API_URL = "https://models.dev/api.json";
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const METADATA_TIMEOUT_MS = 10_000;

/** 倍率基准：deepseek-v4.1-flash（先试官方供应商，再退回裸 ID 查找）。 */
const BASELINE_PROVIDER = "deepseek";
const BASELINE_MODEL = "deepseek-v4.1-flash";

/**
 * models.dev 归一化口径的 1x 基准模型：未设管理员基准（或所选模型没有
 * 倍率数据）时，全部倍率以此为分母。展示层也应回退到该模型名。
 */
export const DEFAULT_BASELINE_MODEL = BASELINE_MODEL;

/** 基准取该模型峰时输出费率；三种倍率统一以其为分母（输入也基于输出价，见下方归一化）。 */
const BASELINE_RATE = "output" as const;

/** 裸 ID 的成本在多家供应商重复出现时，优先采信官方/一线供应商。 */
const CANONICAL_PROVIDERS: Record<string, true> = {
  [BASELINE_PROVIDER]: true,
  openai: true,
  anthropic: true,
  google: true,
  zhipu: true,
  moonshot: true,
  moonshotai: true,
  alibaba: true,
  qwen: true,
  minimax: true,
  xai: true,
  mistral: true,
  meta: true,
  microsoft: true,
  amazon: true,
};

const apiModelSchema = z.object({
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      // api.json 用 snake_case；zod 对象键与输出键一致，直接读取 cache_read。
      cache_read: z.number(),
    })
    .partial()
    .optional(),
});

export interface ModelRates {
  input: number;
  output: number;
  /** 缓存读取倍率（归一化到同一基准）。 */
  cacheRead: number;
}

export type ModelRateMap = Record<string, ModelRates>;

interface MetadataCache {
  fetchedAt: number;
  rates: ModelRateMap;
}

let cache: MetadataCache | null = null;
let inflight: Promise<MetadataCache> | null = null;

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function fetchMetadata(): Promise<MetadataCache> {
  const apiPayload = await fetch(API_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`api.json ${response.status}`))))
    .catch(() => null);

  // —— 默认倍率：来自 api.json 的 cost，以基准模型的峰时输出成本归一化 ——
  const rates: ModelRateMap = {};
  if (apiPayload) {
    const api = z
      .record(z.string(), z.object({ models: z.record(z.string(), apiModelSchema).optional() }))
      .safeParse(apiPayload);
    if (api.success) {
      const providers = api.data as Record<
        string,
        { models?: Record<string, { cost?: { input?: number; output?: number; cache_read?: number } } | undefined> | undefined }
      >;

      // 两遍扫描：先收集所有有效 cost 条目，再解析基准与裸 ID 别名。
      interface CostEntry {
        provider: string;
        modelId: string;
        input: number;
        output: number;
        /** models.dev 缺 cache_read 时按 1x 归一化（与输入/输出缺数据同规则）。 */
        cacheRead: number | null;
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
            cacheRead: typeof cost?.cache_read === "number" && cost.cache_read > 0 ? cost.cache_read : null,
            canonical: CANONICAL_PROVIDERS[providerName] === true,
          });
        }
      }

      const pickCost = (modelId: string, preferredProvider?: string): { input: number; output: number } | null => {
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
      let baseline: { input: number; output: number } | null = null;
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
          // 输入、输出倍率统一以基准峰时输出成本为分母：deepseek-v4.1-flash
          // 输出倍率恰为 1.0，其输入倍率（及一切其他倍率）按该费率折算。
          // 缓存读取倍率同分母折算；models.dev 缺 cache_read 时按输入价计
          // （大多数不收缓存折扣的供应商就是这样）。
          const base = baseline[BASELINE_RATE];
          const cacheRead = entry.cacheRead ?? entry.input;
          const rate: ModelRates = {
            input: round4(entry.input / base),
            output: round4(entry.output / base),
            // 缓存读取价按 models.dev 原值折算：少数供应商的缓存读取报价
            // 高于输入价（或把缓存写入价填在该字段），夹取会静默改价。
            cacheRead: round4(cacheRead / base),
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

  return { fetchedAt: Date.now(), rates };
}

/**
 * models.dev 元数据的进程内缓存 + MongoDB 持久化兜底。
 *
 * 只放进程内缓存在 serverless 上不够：冷启动遇到 models.dev 不可达时
 * `rates` 为空，所有模型都会按 1x 计费（模型间相对价格全丢）。因此每次
 * 成功拉取都写一份快照，冷启动/故障时用最后一份好数据。
 */
interface MetadataSnapshotDoc {
  _id: string;
  fetchedAt: number;
  rates: ModelRateMap;
}

const SNAPSHOT_ID = "models_dev";

async function readSnapshot(): Promise<MetadataCache | null> {
  try {
    const db = await getDb();
    const doc = await db.collection<MetadataSnapshotDoc>("model_metadata").findOne({ _id: SNAPSHOT_ID });
    if (!doc || !doc.rates || Object.keys(doc.rates).length === 0) {
      return null;
    }
    return { fetchedAt: doc.fetchedAt, rates: doc.rates };
  } catch {
    return null;
  }
}

async function writeSnapshot(cache: MetadataCache): Promise<void> {
  try {
    const db = await getDb();
    await db.collection<MetadataSnapshotDoc>("model_metadata").updateOne(
      { _id: SNAPSHOT_ID },
      { $set: { fetchedAt: cache.fetchedAt, rates: cache.rates } },
      { upsert: true },
    );
  } catch {
    // 快照只是兜底：写失败不影响本次请求。
  }
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
    .then(async (data) => {
      // models.dev 完全不可达时不缓存空结果，避免一次瞬时故障把
      // 24h 缓存投毒成全空（显示不计费 1x）；下次请求会重试。
      if (Object.keys(data.rates).length === 0) {
        throw new Error("models.dev returned no metadata");
      }
      cache = data;
      await writeSnapshot(data);
      return data;
    })
    .catch(async () => {
      if (cache) {
        return cache;
      }
      // 冷实例 + 拉取失败：退回数据库里的最后一份好数据，而不是让
      // 所有模型都按 1x 计费。
      const snapshot = await readSnapshot();
      if (snapshot) {
        cache = snapshot;
        return snapshot;
      }
      return { fetchedAt: 0, rates: {} as ModelRateMap };
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
