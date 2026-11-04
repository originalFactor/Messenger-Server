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

/**
 * 生效倍率解析的唯一事实来源：`/v1` 代理计费、模型广场、`/v1/models`
 * 与控制台展示都走这里，避免四份实现漂移。
 *
 * 两层口径：
 * - 存量价目卡（stored card）长期保存在归一化空间里，与基准无关：
 *   自定义值逐腿生效（缺失腿回退上游报价 → pi-catalog），
 *   无数据默认 1x，显式 0 = 不计费。旧 override=false 的休眠倍率保持忽略。四种腿
 *   （输入 / 缓存读取 / 缓存写入 / 输出）各自解析；长上下文阶梯与峰谷
 *   配置整份跟随同一条来源，不与另一侧逐项混拼（否则阈值/时段会和价格
 *   错配）。
 * - 实际倍率 = 存量卡 ÷ 基准模型存量卡 × modelRate × providerRate，
 *   基准归一逐腿进行（输入除输入、缓存写入除缓存写入……），因此基准
 *   模型自身每条腿都恰为 1x。
 *
 * 上游报价（`upstreams.modelPrices`）来自上游自己的 `/v1/models` 响应里的
 * `input_rate` / `cache_read_rate` / `cache_write_rate` / `output_rate`，
 * 与本站 `/v1/models` 输出同构（已是倍率口径，不是美元价）；可带 `tiers`
 * （长上下文阶梯）与 `timeBased`（峰谷）。上游未返回、或某腿返回 0，
 * 逐腿回退 pi-catalog。
 *
 * 设了 1x 基准模型 B 时，其余模型（含 override 覆盖条目）的实际倍率按 B
 * 重新归一 —— 基准切换只改解析口径、不改任何存量数据，因此随时可逆、不
 * 产生浮点漂移，模型间的相对价格关系恒定。未设基准时分母取 1（归一化
 * 口径）。
 *
 * 缓存读取/写入倍率按配置原样生效，不做「不得高于输入价」的夹取 —— 个别
 * 供应商的缓存读取报价确实高于输入价（也有把缓存写入价填进该字段的
 * 情况），静默改写会让命中缓存反而按输入价计费。
 */

import {
  type LongContextTier,
  type RateCard,
  type TimeBasedPricing,
  type TokenRates,
  effectiveRates,
  normalizeTiers,
  normalizeTimeBased,
  selectLongContextTier,
  timeBasedMultiplier,
} from "@/lib/pricing";
import type { CatalogRateMap } from "@/lib/pi-catalog";
import type {
  PricingSchedule,
  PricingTier,
  UpstreamModelMeta,
  UpstreamModelPrice,
} from "@/lib/types";

/** 一次解析的最终结果（每条腿的实际倍率 + 命中情况）。 */
export interface ResolvedRates {
  inputRate: number;
  outputRate: number;
  cacheReadRate: number;
  cacheWriteRate: number;
  /** 请求命中的长上下文档阈值；未命中为 null。 */
  longContextThreshold: number | null;
  /** 实际套用的峰谷系数（峰值 = 1，谷时 = offPeakMultiplier）。 */
  timeMultiplier: number;
}

/** 1x 基准上下文：只需基准模型 ID，基准存量卡按上游各自解析。 */
export interface BaseModelContext {
  modelId: string;
}

/** 倍率有效化：有限且 >= 0 才采纳，其余（含 undefined/null）按 1（不缩放）处理。 */
export function normalizeMultiplier(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 1;
}

/** 保留具体版本和价格变体，只移除命名包装及推理档位。 */
function modelDefaultCandidates(modelId: string): string[] {
  const withoutTail = modelId.replace(/-(thinking|high|low|medium)$/i, "");
  // Bedrock 的 :0 是版本标记，不能被误当作 prefix:model 的分隔符。
  const withoutPrefix = modelId.replace(/^(?:[^:/]+\/|[^:/]+:(?!(?:\d+|free|extended|nitro|online)$))(?=.)/i, "");
  const candidates = new Set([
    modelId,
    withoutTail,
    withoutPrefix,
    withoutPrefix.replace(/-(thinking|high|low|medium)$/i, ""),
  ]);
  for (const candidate of candidates) {
    // 目录键可能叠加 catalog-provider/model-provider/model 两层前缀。
    const unwrapped = candidate.replace(/^(?:[^:/]+\/|[^:/]+:(?!(?:\d+|free|extended|nitro|online)$))(?=.)/i, "");
    candidates.add(unwrapped);
    const bedrock = unwrapped.match(/^(?:(?:us|eu|apac|global)\.)?(?:amazon|anthropic|cohere|deepseek|meta|mistral|nvidia|openai|qwen|writer|ai21)\.(.+)$/i);
    if (bedrock) {
      candidates.add(bedrock[1]);
      candidates.add(bedrock[1].replace(/-v\d+(?::\d+)?$/i, ""));
    }
  }
  return [...candidates];
}

/** 两侧均去命名包装；完整 ID 优先，所有候选忽略大小写。 */
export function matchModelDefault<T>(modelId: string, defaults: Readonly<Record<string, T>>): T | undefined {
  const candidates = modelDefaultCandidates(modelId);
  let keys: string[] | undefined;
  for (const candidate of candidates) {
    if (Object.hasOwn(defaults, candidate) && defaults[candidate] !== undefined) {
      return defaults[candidate];
    }
    keys ??= Object.keys(defaults);
    const folded = candidate.toLowerCase();
    const key = keys.find((key) => key.toLowerCase() === folded && defaults[key] !== undefined);
    if (key !== undefined) {
      return defaults[key];
    }
  }
  // 先穷尽原始目录键，再尝试目录一侧的别名，避免别名盖过独立变体的报价。
  const foldedCandidates = new Set(candidates.map((candidate) => candidate.toLowerCase()));
  for (const key of keys ?? Object.keys(defaults)) {
    if (defaults[key] !== undefined
      && modelDefaultCandidates(key).some((candidate) => foldedCandidates.has(candidate.toLowerCase()))) {
      return defaults[key];
    }
  }
  return undefined;
}

/** 手选目录键精确取值；失效时不偷偷改配另一个模型。 */
export function catalogModelDefault<T>(
  modelId: string,
  defaults: Readonly<Record<string, T>>,
  catalogModelId?: string | null,
): T | undefined {
  if (catalogModelId) {
    return Object.hasOwn(defaults, catalogModelId) ? defaults[catalogModelId] : undefined;
  }
  return matchModelDefault(modelId, defaults);
}

/** 供目录选择器排序：完整 ID、规范化相同、名称相似依次优先。 */
export function rankCatalogModels(modelId: string, catalogIds: readonly string[], search = ""): string[] {
  const source = modelDefaultCandidates(modelId).map((id) => id.toLowerCase());
  const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const grams = (id: string): Set<string> => {
    const text = id.replace(/[^a-z0-9]/g, "");
    return new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => text.slice(i, i + 2)));
  };
  const sourceGrams = source.map(grams);
  return catalogIds
    .filter((id) => terms.every((term) => id.toLowerCase().includes(term)))
    .map((id) => {
      const targets = modelDefaultCandidates(id).map((candidate) => candidate.toLowerCase());
      let score = 0;
      for (const [i, target] of targets.entries()) {
        const targetGrams = grams(target);
        for (const [j, original] of source.entries()) {
          const exact = target === original;
          const overlap = [...targetGrams].filter((gram) => sourceGrams[j].has(gram)).length;
          const similarity = 2 * overlap / Math.max(1, targetGrams.size + sourceGrams[j].size);
          score = Math.max(score, exact ? 2 - (i + j) * 0.001 : similarity);
        }
      }
      return { id, score };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map(({ id }) => id);
}

/** 逐腿有效化：缺省 / 非有限值 / 0 都视为「未返回」，回退下一级来源。 */
function upstreamRate(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundCard(card: RateCard): RateCard {
  return {
    input: round4(card.input),
    output: round4(card.output),
    cacheRead: round4(card.cacheRead),
    cacheWrite: round4(card.cacheWrite),
    ...(card.tiers
      ? { tiers: card.tiers.map((tier) => ({
          ...tier,
          input: round4(tier.input),
          output: round4(tier.output),
          cacheRead: round4(tier.cacheRead),
          cacheWrite: round4(tier.cacheWrite),
        })) }
      : {}),
    ...(card.timeBased ? { timeBased: card.timeBased } : {}),
  };
}

/**
 * 缓存折扣比例（读取 or 写入 ÷ 输入）：上游报价给了输入与对应腿时用上游的
 * （上游自报的折扣最可信），否则用 pi-catalog 的同一比例，都没有按 1
 * （不收缓存折扣的供应商即如此）。
 */
function cacheDiscountRatio(
  catalogCard: RateCard | undefined,
  price: UpstreamModelPrice | undefined,
  leg: "cacheRead" | "cacheWrite",
): number {
  const priceInput = upstreamRate(price?.inputRate);
  const priceLeg = upstreamRate(leg === "cacheRead" ? price?.cacheReadRate : price?.cacheWriteRate);
  if (priceInput !== undefined && priceLeg !== undefined) {
    return priceLeg / priceInput;
  }
  // 旧快照没有 cacheWrite 腿（undefined）时按 1 处理，避免 NaN 扩散到整条链。
  const catalogLeg = catalogCard?.[leg];
  if (catalogCard && catalogCard.input > 0 && typeof catalogLeg === "number" && Number.isFinite(catalogLeg)) {
    return catalogLeg / catalogCard.input;
  }
  return 1;
}

/** 上游报价里的阶梯（内部形状）→ 复用定价模块的规范化（缺腿按 0 补齐）。 */
function normalizePriceTiers(tiers: UpstreamModelPrice["tiers"]): LongContextTier[] | undefined {
  if (!tiers || tiers.length === 0) {
    return undefined;
  }
  return normalizeTiers(
    tiers.map((tier) => ({
      inputThreshold: tier.inputThreshold,
      ...(tier.inputThresholdInclusive !== undefined
        ? { inputThresholdInclusive: tier.inputThresholdInclusive }
        : {}),
      input: upstreamRate(tier.inputRate) ?? 0,
      output: upstreamRate(tier.outputRate) ?? 0,
      cacheRead: upstreamRate(tier.cacheReadRate) ?? 0,
      cacheWrite: upstreamRate(tier.cacheWriteRate) ?? 0,
    })),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
}

/** 自定义覆盖里的阶梯（可能只写了部分腿）→ 缺腿沿用该模型的基础档。 */
function normalizeMetaTiers(
  tiers: PricingTier[] | null | undefined,
  fallback: TokenRates,
): LongContextTier[] | undefined {
  if (!tiers || tiers.length === 0) {
    return undefined;
  }
  return normalizeTiers(
    tiers.map((tier) => ({
      inputThreshold: tier.inputThreshold,
      ...(tier.inputThresholdInclusive !== undefined
        ? { inputThresholdInclusive: tier.inputThresholdInclusive }
        : {}),
      input: tier.inputRate ?? fallback.input,
      output: tier.outputRate ?? fallback.output,
      cacheRead: tier.cacheReadRate ?? fallback.cacheRead,
      cacheWrite: tier.cacheWriteRate ?? fallback.cacheWrite,
    })),
    fallback,
  );
}

/** 上游报价的驼峰峰谷 / 自定义峰谷 → 复用定价模块的规范化（无合法窗口即未配置）。 */
function normalizeSchedule(
  schedule: PricingSchedule | UpstreamModelPrice["timeBased"] | null | undefined,
): TimeBasedPricing | undefined {
  if (!schedule) {
    return undefined;
  }
  return normalizeTimeBased({
    offPeakMultiplier: schedule.offPeakMultiplier,
    peakWindows: schedule.peakWindows ?? [],
  });
}

/** 上游报价里「有没有任何长效结构」（阶梯/峰谷），决定它能否覆盖目录的同名配置。 */
function hasStructure(price: UpstreamModelPrice | undefined): boolean {
  return price?.tiers !== undefined || price?.timeBased !== undefined;
}

/**
 * 存量价目卡（不含基准归一、不含 modelRate/providerRate 缩放）：
 * 逐腿取非空自定义值，缺省回退上游报价 → pi-catalog，无数据按 1x。
 *
 * 长上下文阶梯与峰谷配置整份跟随来源：自定义没写就用上游的、上游没给就用
 * 目录的，绝不把两边的阈值与价格混配。
 */
export function currentStoredCard(
  model: string,
  stored: UpstreamModelMeta | undefined,
  defaults: CatalogRateMap,
  upstreamPrice?: UpstreamModelPrice | null,
): RateCard {
  const catalogCard = catalogModelDefault(model, defaults, stored?.catalogModelId);
  const priceCard = upstreamPrice ?? undefined;
  const readDiscount = cacheDiscountRatio(catalogCard, priceCard, "cacheRead");
  const writeDiscount = cacheDiscountRatio(catalogCard, priceCard, "cacheWrite");

  const devInput = upstreamRate(priceCard?.inputRate) ?? catalogCard?.input ?? 1;
  const devOutput = upstreamRate(priceCard?.outputRate) ?? catalogCard?.output ?? 1;
  // 缓存腿：上游报价优先，缺省按折扣比例折算到实际输入价（两套口径不同，
  // 直接沿用目录的绝对倍率会得到数倍于输入价的缓存价）。
  const devCacheRead = upstreamRate(priceCard?.cacheReadRate) ?? round4(devInput * readDiscount);
  const devCacheWrite = upstreamRate(priceCard?.cacheWriteRate) ?? round4(devInput * writeDiscount);

  // 结构整份取用：自定义 > 上游报价（仅在它给了结构时）> 目录。
  // 自定义阶梯未填的腿沿用该模型解析出的基础档，避免只写阈值时其余腿变 0。
  const structuredPrice = hasStructure(priceCard) ? priceCard : undefined;
  const custom = stored?.override === false ? undefined : stored;
  const baseLegs = {
    input: custom?.inputRate ?? devInput,
    output: custom?.outputRate ?? devOutput,
    cacheRead: custom?.cacheReadRate ?? devCacheRead,
    cacheWrite: custom?.cacheWriteRate ?? devCacheWrite,
  };
  const tiers = normalizeMetaTiers(stored?.tiers, baseLegs)
    ?? normalizePriceTiers(structuredPrice?.tiers)
    ?? catalogCard?.tiers;
  const timeBased = normalizeSchedule(stored?.timeBased)
    ?? normalizeSchedule(structuredPrice?.timeBased)
    ?? catalogCard?.timeBased;
  const extras: Pick<RateCard, "tiers" | "timeBased"> = {
    ...(tiers ? { tiers } : {}),
    ...(timeBased ? { timeBased } : {}),
  };

  return { ...baseLegs, ...extras };
}

/** 逐腿缩放（modelRate × providerRate）；阶梯与峰谷同比例缩放。 */
function scaleCard(card: RateCard, scale: number): RateCard {
  if (!Number.isFinite(scale) || scale === 1) {
    return card;
  }
  return {
    input: card.input * scale,
    output: card.output * scale,
    cacheRead: card.cacheRead * scale,
    cacheWrite: card.cacheWrite * scale,
    ...(card.tiers
      ? { tiers: card.tiers.map((tier) => ({
          ...tier,
          input: tier.input * scale,
          output: tier.output * scale,
          cacheRead: tier.cacheRead * scale,
          cacheWrite: tier.cacheWrite * scale,
        })) }
      : {}),
    ...(card.timeBased ? { timeBased: card.timeBased } : {}),
  };
}

/** 基准归一：逐腿相除，分母为零/缺失时该腿按 1（不缩放）。 */
function divideCard(card: RateCard, divisor: RateCard): RateCard {
  const d = (value: number, base: number): number => (base > 0 && Number.isFinite(base) ? value / base : value);
  return {
    input: d(card.input, divisor.input),
    output: d(card.output, divisor.output),
    cacheRead: d(card.cacheRead, divisor.cacheRead),
    cacheWrite: d(card.cacheWrite, divisor.cacheWrite),
    ...(card.tiers
      ? { tiers: card.tiers.map((tier) => ({
          ...tier,
          input: d(tier.input, divisor.input),
          output: d(tier.output, divisor.output),
          cacheRead: d(tier.cacheRead, divisor.cacheRead),
          cacheWrite: d(tier.cacheWrite, divisor.cacheWrite),
        })) }
      : {}),
    ...(card.timeBased ? { timeBased: card.timeBased } : {}),
  };
}

function cardToRates(card: RateCard, atMs: number, promptTokens: number): ResolvedRates {
  const applied = effectiveRates(card, { promptTokens, atMs });
  const tier = selectLongContextTier(card.tiers, promptTokens);
  // 从生效价反推峰谷系数：梯度档已是「该档的价」，除以它就是峰谷系数。
  const baseInput = tier ? tier.input : card.input;
  const multiplier = timeBasedMultiplier(card.timeBased, atMs);
  return {
    inputRate: round4(applied.input),
    outputRate: round4(applied.output),
    cacheReadRate: round4(applied.cacheRead),
    cacheWriteRate: round4(applied.cacheWrite),
    longContextThreshold: tier?.inputThreshold ?? null,
    timeMultiplier: baseInput > 0 ? round4(applied.input / baseInput) : multiplier,
  };
}

/**
 * 按模型解析出**已归一、已缩放**的价目卡（尚未选阶梯、尚未套峰谷）：
 *   实际卡 = 存量卡 ÷ 基准卡 × modelRate × providerRate
 * 广场需要判断阶梯/峰谷是否存在，因此单独暴露这一层。
 */
export function resolveModelCard(
  upstream: Pick<UpstreamDocLike, "modelMeta" | "modelPrices" | "multiplier">,
  model: string,
  defaults: CatalogRateMap,
  base: BaseModelContext | null = null,
): RateCard {
  const custom: UpstreamModelMeta | undefined = upstream.modelMeta?.[model];
  const stored = currentStoredCard(model, custom, defaults, upstream.modelPrices?.[model]);
  const modelRate = normalizeMultiplier(custom?.multiplier);
  const providerRate = normalizeMultiplier(upstream.multiplier);
  // base == model 时 stored ÷ baseStored 恒为 1，无需特例分支。
  const baseStored = base
    ? currentStoredCard(
        base.modelId,
        upstream.modelMeta?.[base.modelId],
        defaults,
        upstream.modelPrices?.[base.modelId],
      )
    : { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
  const normalized = roundCard(divideCard(stored, baseStored));
  return scaleCard(normalized, modelRate * providerRate);
}

/**
 * 按模型解析实际倍率：
 * 实际倍率 = 存量卡 ÷ 基准卡 × modelRate × providerRate，
 * 再按提示总重量选长上下文档、按请求时刻套峰谷系数。
 *
 * 传入 `usage` 才会应用阶梯与峰谷；不传（控制台比较价格、模型广场展示）
 * 时返回基础档、峰值牌价，便于横向比较。
 */
export function resolveModelRates(
  upstream: Pick<UpstreamDocLike, "modelMeta" | "modelPrices" | "multiplier">,
  model: string,
  defaults: CatalogRateMap,
  base: BaseModelContext | null = null,
  usage: { promptTokens: number; atMs: number } | null = null,
): ResolvedRates {
  const scaled = resolveModelCard(upstream, model, defaults, base);
  return cardToRates(scaled, usage?.atMs ?? Date.now(), usage?.promptTokens ?? 0);
}

/**
 * 1x 基准上下文：只有在该模型确实有可解析的倍率时才启用 —— pi-catalog
 * 有记录，某个上游在 `/v1/models` 里自报了它的价格，或某个上游用覆盖
 * 条目给了它倍率。都没有时基准恒为 1x 分母，与「未设基准」等价。
 */
export function resolveBaseContext(
  baseModelId: string | null,
  defaults: CatalogRateMap,
  upstreams: readonly Pick<UpstreamDocLike, "modelMeta" | "modelPrices">[],
): BaseModelContext | null {
  if (baseModelId === null) {
    return null;
  }
  if (matchModelDefault(baseModelId, defaults) !== undefined) {
    return { modelId: baseModelId };
  }
  const resolvable = upstreams.some((upstream) => {
    if (catalogModelDefault(baseModelId, defaults, upstream.modelMeta?.[baseModelId]?.catalogModelId) !== undefined) {
      return true;
    }
    const price = upstream.modelPrices?.[baseModelId];
    if (
      price !== undefined
      && (upstreamRate(price.inputRate) !== undefined
        || upstreamRate(price.outputRate) !== undefined
        || upstreamRate(price.cacheReadRate) !== undefined
        || upstreamRate(price.cacheWriteRate) !== undefined)
    ) {
      return true;
    }
    const custom = upstream.modelMeta?.[baseModelId];
    return custom?.override !== false
      && (upstreamRate(custom?.inputRate) !== undefined
        || upstreamRate(custom?.outputRate) !== undefined
        || upstreamRate(custom?.cacheReadRate) !== undefined
        || upstreamRate(custom?.cacheWriteRate) !== undefined);
  });
  return resolvable ? { modelId: baseModelId } : null;
}

/** 解析用的最小上游形状（modelMeta + modelPrices + multiplier 即可）。 */
interface UpstreamDocLike {
  modelMeta?: Record<string, UpstreamModelMeta> | null;
  modelPrices?: Record<string, UpstreamModelPrice> | null;
  multiplier?: number | null;
}
