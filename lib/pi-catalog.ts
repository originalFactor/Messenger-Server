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
import { createLogger } from "@/lib/runtime-logs";

/**
 * pi-catalog 公开模型价目表（https://pi.dev/api/models）：
 * 按供应商嵌套，条目带 cost（每百万 token 的美元价格：input / output /
 * cacheRead），用于在上游 `/v1/models` 没有报价时提供默认输入/输出/缓存
 * 读取倍率 —— 基准为 deepseek/deepseek-flash 的输出价格（其输出倍率恰为
 * 1.0），所有倍率（含该模型自身的输入倍率）都以该基准输出价为分母折算，
 * 单位在比值中抵消。
 *
 * 上线顺序：上游自己在 `/v1/models` 返回的报价（`upstreams.modelPrices`）
 * 优先，其次才是这里；两者都没有则按 1x（显式 0 = 不计费只来自自定义覆盖）。
 *
 * 上下文窗口不由服务端下发（客户端自行推导）。条目缺 cacheRead 时按该
 * 模型的输入价折算（不收缓存折扣的供应商即如此）；长上下文阶梯价（`tiers`）
 * 不参与折算，取基础档。
 *
 * 载荷在实例内存中缓存 24 小时，并每次成功拉取后落库一份快照；拉取失败
 * 时回退内存缓存，冷实例再回退数据库快照，永不抛出。
 */

const API_URL = "https://pi.dev/api/models";
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 10_000;

/** 倍率基准：deepseek-flash（先试官方供应商，再退回裸 ID 查找）。 */
const BASELINE_PROVIDER = "deepseek";
const BASELINE_MODEL = "deepseek-flash";

/** 基准取该模型输出价格；三种倍率统一以其为分母（输入也基于输出价，见下方归一化）。 */
const BASELINE_RATE = "output" as const;

/**
 * 裸 ID 的价格在多家供应商重复出现时，优先采信官方/一线供应商。
 * 聚合市场（openrouter、vercel-ai-gateway、opencode-go 等）带自己的
 * 加价/折扣，不作为「官方牌价」参与裸 ID 归一。
 */
const CANONICAL_PROVIDERS: Record<string, true> = {
  [BASELINE_PROVIDER]: true,
  openai: true,
  anthropic: true,
  google: true,
  "google-vertex": true,
  zai: true,
  moonshotai: true,
  qwen: true,
  minimax: true,
  xai: true,
  mistral: true,
  meta: true,
  "amazon-bedrock": true,
};

/**
 * pi-catalog 的 `cost` 是驼峰命名（cacheRead），与 models.dev 的 snake_case
 * 不同；另有 `cacheWrite` 与长上下文阶梯价 `tiers`，两者都不参与折算
 * （阶梯价取基础档）。
 */
const catalogModelSchema = z.object({
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
    })
    .partial()
    .passthrough()
    .optional(),
});

export interface CatalogRates {
  input: number;
  output: number;
  /** 缓存读取倍率（归一化到同一基准）。 */
  cacheRead: number;
}

export type CatalogRateMap = Record<string, CatalogRates>;

interface CatalogCache {
  fetchedAt: number;
  rates: CatalogRateMap;
  /** True when the data came from a stale snapshot or an empty-rate fallback. */
  degraded: boolean;
}

let cache: CatalogCache | null = null;
let inflight: Promise<CatalogCache> | null = null;

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function fetchCatalog(): Promise<CatalogCache> {
  const payload = await fetch(API_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`pi catalog ${response.status}`))))
    .catch(() => null);

  // —— 默认倍率：来自 pi-catalog 的 cost，以基准模型的输出价格归一化 ——
  const rates: CatalogRateMap = {};
  // 逐个条目校验而不是整包 safeParse：目录是活数据，一个供应商的形状漂移
  // 不该让全部模型退化成 1x。
  const providers = z.record(z.string(), z.unknown()).safeParse(payload);
  if (payload && providers.success) {
    // 两遍扫描：先收集所有有效 cost 条目，再解析基准与裸 ID 别名。
    interface CostEntry {
      provider: string;
      modelId: string;
      input: number;
      output: number;
      /** pi-catalog 缺 cacheRead 时按 input 计（与输入/输出缺数据同规则）。 */
      cacheRead: number | null;
      canonical: boolean;
    }
    const entries: CostEntry[] = [];
    for (const [providerName, providerModels] of Object.entries(providers.data)) {
      const models = z.record(z.string(), z.unknown()).safeParse(providerModels);
      if (!models.success) continue;
      for (const [modelId, rawModel] of Object.entries(models.data)) {
        const model = catalogModelSchema.safeParse(rawModel);
        if (!model.success) continue;
        const cost = model.data.cost;
        if (typeof cost?.input !== "number" || typeof cost?.output !== "number") continue;
        if (cost.input <= 0 || cost.output <= 0) continue;
        entries.push({
          provider: providerName,
          modelId,
          input: cost.input,
          output: cost.output,
          cacheRead: typeof cost.cacheRead === "number" && cost.cacheRead > 0 ? cost.cacheRead : null,
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
      // 一线供应商优先（如 deepseek 官方），否则取输入价格最低的报价。
      const chosen = matches.find((entry) => entry.canonical) ?? matches.reduce((a, b) => (b.input < a.input ? b : a));
      return { input: chosen.input, output: chosen.output };
    };

    // 基准候选链：数据源是活数据，条目会漂移，逐个回退直至命中。
    let baseline: { input: number; output: number } | null = null;
    for (const candidate of [
      BASELINE_MODEL,
      `${BASELINE_PROVIDER}/${BASELINE_MODEL}`,
      "deepseek-v4.1-flash",
      `${BASELINE_PROVIDER}/deepseek-v4.1-flash`,
    ]) {
      baseline = pickCost(candidate, candidate.includes("/") ? undefined : BASELINE_PROVIDER);
      if (baseline) {
        break;
      }
    }
    if (baseline) {
      for (const entry of entries) {
        // 输入、输出倍率统一以基准模型输出价格为分母：deepseek/flash 的
        // 输出倍率恰为 1.0，其输入倍率（及一切其他倍率）按该价格折算。
        // 缓存读取倍率同分母折算；缺 cacheRead 时按输入价计（大多数不
        // 收缓存折扣的供应商就是这样）。
        const base = baseline[BASELINE_RATE];
        const cacheRead = entry.cacheRead ?? entry.input;
        const rate: CatalogRates = {
          input: round4(entry.input / base),
          output: round4(entry.output / base),
          // 缓存读取价按目录原值折算：少数供应商的缓存读取报价高于输入价
          // （或把缓存写入价填在该字段），夹取会静默改价。
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

  return { fetchedAt: Date.now(), rates, degraded: false };
}

/**
 * pi-catalog 的进程内缓存 + MongoDB 持久化兜底。
 *
 * 只放进程内缓存在 serverless 上不够：冷启动遇到 pi.dev 不可达时
 * `rates` 为空，没有上游报价的模型都会按 1x 计费（模型间相对价格全丢）。
 * 因此每次成功拉取都写一份快照，冷启动/故障时用最后一份好数据。
 */
interface CatalogSnapshotDoc {
  _id: string;
  fetchedAt: number;
  rates: CatalogRateMap;
}

const SNAPSHOT_ID = "pi_catalog";
const catalogLog = createLogger("relay");

async function readSnapshot(): Promise<CatalogCache | null> {
  try {
    const db = await getDb();
    const doc = await db.collection<CatalogSnapshotDoc>("model_metadata").findOne({ _id: SNAPSHOT_ID });
    if (!doc || !doc.rates || Object.keys(doc.rates).length === 0) {
      return null;
    }
    return { fetchedAt: doc.fetchedAt, rates: doc.rates, degraded: true };
  } catch {
    return null;
  }
}

async function writeSnapshot(snapshot: CatalogCache): Promise<void> {
  try {
    const db = await getDb();
    await db.collection<CatalogSnapshotDoc>("model_metadata").updateOne(
      { _id: SNAPSHOT_ID },
      { $set: { fetchedAt: snapshot.fetchedAt, rates: snapshot.rates } },
      { upsert: true },
    );
  } catch {
    // 快照只是兜底：写失败不影响本次请求。
  }
}

export async function getCatalogRates(forceRefresh = false): Promise<CatalogCache> {
  if (!forceRefresh) {
    if (cache && Date.now() - cache.fetchedAt < CATALOG_TTL_MS) {
      return cache;
    }
    if (inflight) {
      return inflight;
    }
  }
  inflight = fetchCatalog()
    .then(async (data) => {
      // pi.dev 完全不可达时不缓存空结果，避免一次瞬时故障把 24h 缓存
      // 投毒成全空（显示不计费 1x）；下次请求会重试。
      if (Object.keys(data.rates).length === 0) {
        throw new Error("pi-catalog returned no metadata");
      }
      cache = data;
      await writeSnapshot(data);
      return data;
    })
    .catch(async () => {
      if (cache) {
        return cache;
      }
      // 冷实例 + 拉取失败：退回数据库里的最后一份好数据，而不是让没有
      // 上游报价的模型都按 1x 计费。
      const snapshot = await readSnapshot();
      if (snapshot) {
        catalogLog.warn("Using the persisted pi-catalog snapshot after metadata refresh failed.");
        cache = snapshot;
        return snapshot;
      }
      catalogLog.error("pi-catalog metadata is unavailable; rate resolution is degraded to 1x.");
      return { fetchedAt: 0, rates: {} as CatalogRateMap, degraded: true };
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
