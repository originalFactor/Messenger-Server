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
import type { LongContextTier, PeakWindow, RateCard, TimeBasedPricing } from "@/lib/pricing";

/**
 * pi-catalog 公开模型价目表（https://pi.dev/api/models）：
 * 按供应商嵌套，条目带 cost（每百万 token 的美元价格：input / output /
 * cacheRead / cacheWrite，可带长上下文价格 `longContext` 与峰谷配置
 * `timeBased`），用于在上游 `/v1/models` 没有报价时提供默认倍率 ——
 * 基准为 deepseek/deepseek-flash 的输出价格（其输出倍率恰为 1.0），所有
 * 倍率（含该模型自身的输入倍率）都以该基准输出价为分母折算，单位在比值
 * 中抵消。
 *
 * 逐腿来源：上游自己在 `/v1/models` 返回的报价（`upstreams.modelPrices`）
 * 优先，其次这里，都没有则按 1x（显式 0 = 不计费只来自自定义覆盖）。
 * 长上下文阶梯与峰谷配置跟随同一条来源链（各自整体取用，不与另一侧逐项
 * 混拼，否则阈值/时段会和价格错配）。
 *
 * 模型能力供 Messenger Web 的 metadata 查询使用；Android/Desktop 自行推导。
 * 条目缺 cacheRead 时按该模型的输入价折算（不收缓存折扣的供应商即如此）；缺 cacheWrite 时按
 * cacheRead 折算。
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

/** 基准取该模型输出价格；四种倍率统一以其为分母（输入也基于输出价，见下方归一化）。 */
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
 * pi-catalog 的 `cost` 是驼峰命名（cacheRead / cacheWrite），与 models.dev
 * 的 snake_case 不同；`longContext` 转为内部长上下文阶梯（兼容旧 `tiers`），
 * `timeBased` 携带 UTC 峰谷配置。
 */
const catalogTierSchema = z.object({
  inputTokensAbove: z.number(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
}).partial().required({ inputTokensAbove: true });

const peakWindowSchema = z.object({
  weekdays: z.array(z.number()).min(1),
  startMinute: z.number(),
  endMinute: z.number(),
});

const catalogTimeBasedSchema = z.object({
  offPeakMultiplier: z.number(),
  peakWindows: z.array(peakWindowSchema).default([]),
});

const catalogModelSchema = z.object({
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
      tiers: z.array(catalogTierSchema).optional(),
      longContext: z.object({
        inputThreshold: z.number().positive(),
        inputThresholdInclusive: z.boolean().optional(),
        input: z.number().nonnegative().optional(),
        output: z.number().nonnegative().optional(),
        cacheRead: z.number().nonnegative().optional(),
        cacheWrite: z.number().nonnegative().optional(),
      }).optional(),
      timeBased: catalogTimeBasedSchema.optional(),
    })
    .partial()
    .passthrough()
    .optional(),
});

/** Validate providers independently so one malformed provider cannot discard the catalog. */
function decodeCatalog(payload: unknown): Record<string, Record<string, unknown>> {
  const providers = z.record(z.string(), z.unknown()).parse(payload);
  const models: Record<string, Record<string, unknown>> = Object.create(null);
  for (const [provider, value] of Object.entries(providers)) {
    const parsed = z.record(z.string(), z.unknown()).safeParse(value);
    if (parsed.success) models[provider] = parsed.data;
  }
  return models;
}

/** 一份目录条目归一化后的价目卡（基础四腿 + 长上下文阶梯 + 峰谷）。 */
export type CatalogCard = RateCard;

export type CatalogRateMap = Record<string, CatalogCard>;

/** Public model capabilities used by Messenger Web, independently of model pricing. */
export interface CatalogModelMetadata {
  displayName: string | null;
  supportsTemperature: boolean;
  supportsTopP: boolean;
  supportsPenalties: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  inputModalities: string[];
  reasoning: boolean | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}
export type CatalogMetadataMap = Record<string, CatalogModelMetadata>;

const modelMetadataSchema = z.object({
  name: z.string().optional(),
  supportsTemperature: z.boolean().optional(),
  supportsTopP: z.boolean().optional(),
  supportsPenalties: z.boolean().optional(),
  contextWindow: z.number().positive().nullish(),
  maxTokens: z.number().positive().nullish(),
  input: z.array(z.string()).optional(),
  reasoning: z.boolean().optional(),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
  compat: z.object({ supportsTemperature: z.boolean().optional() }).optional(),
});

function extractModelMetadata(providers: Record<string, Record<string, unknown>>): CatalogMetadataMap {
  const metadata: CatalogMetadataMap = Object.create(null);
  const aliases = new Map<string, { provider: string; metadata: CatalogModelMetadata }>();
  for (const [provider, models] of Object.entries(providers)) {
    for (const [id, raw] of Object.entries(models)) {
      const parsed = modelMetadataSchema.safeParse(raw);
      if (!parsed.success) continue;
      const model = parsed.data;
      // Pi: null disables a level, absent standard levels use identity mapping;
      // xhigh/max require an explicit mapping. Expose provider wire values.
      const map = model.thinkingLevelMap;
      const efforts = model.reasoning ? [...new Set([
        ...(typeof map?.off === "string" && map.off ? [map.off] : []),
        ...["minimal", "low", "medium", "high", "xhigh", "max"]
          .filter((level) => map?.[level] !== null && (!(level === "xhigh" || level === "max") || map?.[level] !== undefined))
          .map((level) => map?.[level] ?? level),
      ])] : [];
      const value: CatalogModelMetadata = {
        displayName: model.name ?? null,
        supportsTemperature: model.supportsTemperature ?? model.compat?.supportsTemperature ?? true,
        supportsTopP: model.supportsTopP ?? true,
        supportsPenalties: model.supportsPenalties ?? true,
        contextWindow: model.contextWindow ?? null,
        maxOutputTokens: model.maxTokens ?? null,
        inputModalities: model.input ?? [],
        reasoning: model.reasoning ?? null,
        reasoningEfforts: efforts,
        defaultReasoningEffort: null,
      };
      metadata[`${provider}/${id}`] = value;
      const existing = aliases.get(id);
      if (!existing || (!CANONICAL_PROVIDERS[existing.provider] && CANONICAL_PROVIDERS[provider])) {
        aliases.set(id, { provider, metadata: value });
      }
    }
  }
  for (const [id, entry] of aliases) {
    if (!Object.hasOwn(metadata, id)) metadata[id] = entry.metadata;
  }
  return metadata;
}

interface CatalogCache {
  fetchedAt: number;
  rates: CatalogRateMap;
  models: CatalogMetadataMap;
  /** True when the data came from a stale snapshot or an empty-rate fallback. */
  degraded: boolean;
}

let cache: CatalogCache | null = null;
let inflight: Promise<CatalogCache> | null = null;

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 峰谷窗口规范化：UTC 星期 0–6、分钟 0–1440，起止有效才保留。 */
function normalizePeakWindows(windows: readonly PeakWindow[] | undefined): PeakWindow[] {
  if (!windows) {
    return [];
  }
  return windows
    .filter((window) =>
      Number.isInteger(window.startMinute)
      && Number.isInteger(window.endMinute)
      && window.startMinute >= 0
      && window.endMinute <= 24 * 60
      && window.startMinute < window.endMinute
      && window.weekdays.length > 0
      && window.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6))
    .map((window) => ({
      weekdays: [...new Set(window.weekdays)].sort((a, b) => a - b),
      startMinute: window.startMinute,
      endMinute: window.endMinute,
    }));
}

function normalizeTimeBased(pricing: z.infer<typeof catalogTimeBasedSchema> | undefined): TimeBasedPricing | undefined {
  if (!pricing) {
    return undefined;
  }
  const windows = normalizePeakWindows(pricing.peakWindows);
  if (windows.length === 0) {
    return undefined;
  }
  return {
    offPeakMultiplier: Number.isFinite(pricing.offPeakMultiplier) && pricing.offPeakMultiplier >= 0
      ? pricing.offPeakMultiplier
      : 1,
    peakWindows: windows,
  };
}

/** 阶梯价规范化：阈值正数、四腿缺项按基础档补齐，按阈值升序去重。 */
function normalizeTiers(
  tiers: readonly z.infer<typeof catalogTierSchema>[] | undefined,
  base: { input: number; output: number; cacheRead: number; cacheWrite: number },
): LongContextTier[] | undefined {
  if (!tiers || tiers.length === 0) {
    return undefined;
  }
  const byThreshold = new Map<number, LongContextTier>();
  for (const tier of tiers) {
    if (!(tier.inputTokensAbove > 0)) {
      continue;
    }
    byThreshold.set(tier.inputTokensAbove, {
      inputThreshold: tier.inputTokensAbove,
      input: tier.input ?? base.input,
      output: tier.output ?? base.output,
      cacheRead: tier.cacheRead ?? base.cacheRead,
      cacheWrite: tier.cacheWrite ?? base.cacheWrite,
    });
  }
  if (byThreshold.size === 0) {
    return undefined;
  }
  return [...byThreshold.values()].sort((a, b) => a.inputThreshold - b.inputThreshold);
}

async function fetchCatalog(): Promise<CatalogCache> {
  const payload = await fetch(API_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`pi catalog ${response.status}`))))
    .then(decodeCatalog)
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
      card: CatalogCard;
      /** pi-catalog 缺 cacheRead / cacheWrite 时按基础档补齐。 */
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
        const input = cost.input;
        const output = cost.output;
        // 缺 cacheRead 按输入价（不收缓存折扣的供应商）；缺 cacheWrite 按
        // cacheRead（多数供应商把缓存写入当作一次缓存读取计费，或直接免费）。
        const cacheRead = typeof cost.cacheRead === "number" && cost.cacheRead >= 0 ? cost.cacheRead : input;
        const cacheWrite = typeof cost.cacheWrite === "number" && cost.cacheWrite >= 0
          ? cost.cacheWrite
          : cacheRead;
        const base = { input, output, cacheRead, cacheWrite };
        // The bundled catalog uses a single longContext card; the app uses tiers.
        const tiers: LongContextTier[] | undefined = cost.longContext
          ? [{
              ...base,
              ...cost.longContext,
              inputThreshold: cost.longContext.inputThreshold,
            }]
          : normalizeTiers(cost.tiers, base);
        const timeBased = normalizeTimeBased(cost.timeBased);
        entries.push({
          provider: providerName,
          modelId,
          card: {
            ...base,
            ...(tiers ? { tiers } : {}),
            ...(timeBased ? { timeBased } : {}),
          },
          canonical: CANONICAL_PROVIDERS[providerName] === true,
        });
      }
    }

    const pickEntry = (modelId: string, preferredProvider?: string): CostEntry | null => {
      if (preferredProvider) {
        const direct = entries.find((entry) => entry.modelId === modelId && entry.provider === preferredProvider);
        if (direct) {
          return direct;
        }
      }
      const matches = entries.filter((entry) => entry.modelId === modelId);
      if (matches.length === 0) {
        return null;
      }
      // 一线供应商优先（如 deepseek 官方），否则取输入价格最低的报价。
      return matches.find((entry) => entry.canonical) ?? matches.reduce((a, b) => (b.card.input < a.card.input ? b : a));
    };

    // 基准候选链：数据源是活数据，条目会漂移，逐个回退直至命中。
    let baseline: CostEntry | null = null;
    for (const candidate of [
      BASELINE_MODEL,
      `${BASELINE_PROVIDER}/${BASELINE_MODEL}`,
      "deepseek-v4.1-flash",
      `${BASELINE_PROVIDER}/deepseek-v4.1-flash`,
    ]) {
      baseline = pickEntry(candidate, candidate.includes("/") ? undefined : BASELINE_PROVIDER);
      if (baseline) {
        break;
      }
    }
    if (baseline) {
      const denominator = baseline.card[BASELINE_RATE];
      const aliases = new Map<string, CostEntry>();
      for (const entry of entries) {
        // 输入、输出、缓存读取、缓存写入倍率统一以基准模型输出价格为分母：
        // deepseek/flash 的输出倍率恰为 1.0，其余腿按该价格折算。长上下文
        // 阶梯同分母折算（否则阶梯档会与基础档差一个量级）；峰谷系数是
        // 无量纲比值，原样保留。
        const rate: CatalogCard = {
          input: round4(entry.card.input / denominator),
          output: round4(entry.card.output / denominator),
          // 缓存价按目录原值折算：少数供应商的缓存读取报价高于输入价
          // （或把缓存写入价填在该字段），夹取会静默改价。
          cacheRead: round4(entry.card.cacheRead / denominator),
          cacheWrite: round4(entry.card.cacheWrite / denominator),
          ...(entry.card.tiers
            ? { tiers: entry.card.tiers.map((tier) => ({
                ...tier,
                input: round4(tier.input / denominator),
                output: round4(tier.output / denominator),
                cacheRead: round4(tier.cacheRead / denominator),
                cacheWrite: round4(tier.cacheWrite / denominator),
              })) }
            : {}),
          ...(entry.card.timeBased ? { timeBased: entry.card.timeBased } : {}),
        };
        rates[`${entry.provider}/${entry.modelId}`] = rate;
        const existing = aliases.get(entry.modelId);
        if (!existing || (!existing.canonical && (entry.canonical || entry.card.input < existing.card.input))) {
          aliases.set(entry.modelId, entry);
        }
      }
      // Provider-qualified keys must not be overwritten by aggregator model IDs
      // such as "deepseek/deepseek-v4-flash" when constructing bare aliases.
      for (const [modelId, entry] of aliases) {
        if (!Object.hasOwn(rates, modelId)) {
          rates[modelId] = rates[`${entry.provider}/${entry.modelId}`];
        }
      }
    }
  }

  return { fetchedAt: Date.now(), rates, models: payload ? extractModelMetadata(payload) : {}, degraded: false };
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
  models?: CatalogMetadataMap;
  sourceUrl?: string;
}

const SNAPSHOT_ID = "pi_catalog";
const catalogLog = createLogger("relay");

async function readSnapshot(): Promise<CatalogCache | null> {
  try {
    const db = await getDb();
    const doc = await db.collection<CatalogSnapshotDoc>("model_metadata").findOne({ _id: SNAPSHOT_ID });
    if (!doc || doc.sourceUrl !== API_URL || !doc.rates || Object.keys(doc.rates).length === 0) {
      return null;
    }
    // 上一版快照没有 cacheWrite 腿：补齐后再返回，否则整条解析链会出现
    // undefined / NaN。写入免费（0）的条目保持 0，而不是回退到 cacheRead。
    const rates: CatalogRateMap = {};
    for (const [modelId, rate] of Object.entries(doc.rates)) {
      rates[modelId] = {
        input: rate.input,
        output: rate.output,
        cacheRead: rate.cacheRead,
        cacheWrite: typeof rate.cacheWrite === "number" ? rate.cacheWrite : 0,
        ...(rate.tiers ? { tiers: rate.tiers } : {}),
        ...(rate.timeBased ? { timeBased: rate.timeBased } : {}),
      };
    }
    return { fetchedAt: doc.fetchedAt, rates, models: doc.models ?? {}, degraded: true };
  } catch {
    return null;
  }
}

async function writeSnapshot(snapshot: CatalogCache): Promise<void> {
  try {
    const db = await getDb();
    await db.collection<CatalogSnapshotDoc>("model_metadata").updateOne(
      { _id: SNAPSHOT_ID },
      { $set: { fetchedAt: snapshot.fetchedAt, rates: snapshot.rates, models: snapshot.models, sourceUrl: API_URL } },
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
      return { fetchedAt: 0, rates: {} as CatalogRateMap, models: {}, degraded: true };
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
