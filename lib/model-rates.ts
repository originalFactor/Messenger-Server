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
 * - 存量倍率（stored）长期保存在归一化空间里，与基准无关：
 *   override 开启用自定义值（缺失字段回退上游报价 → pi-catalog），关闭用
 *   上游报价 → pi-catalog，无数据默认 1x，显式 0 = 不计费。
 * - 实际倍率 = 存量倍率 ÷ 基准模型存量倍率 × modelRate × providerRate。
 *
 * 上游报价（`upstreams.modelPrices`）来自上游自己的 `/v1/models` 响应里的
 * `input_rate` / `cache_read_rate` / `output_rate`，与本站 `/v1/models`
 * 输出同构（已是倍率口径，不是美元价）。上游未返回、或返回 0 的字段逐个
 * 回退 pi-catalog（`lib/pi-catalog.ts`）。
 *
 * 设了 1x 基准模型 B 时，B 自身恒为 1x（存量 ÷ 自身存量），其余模型
 * （含 override 覆盖条目）的实际倍率按 B 重新归一 —— 基准切换只改解析
 * 口径、不改任何存量数据，因此随时可逆、不产生浮点漂移，模型间的相对
 * 价格关系恒定。未设基准时分母取 1（归一化口径）。
 *
 * 缓存读取倍率按配置原样生效，不做「不得高于输入价」的夹取 —— 个别
 * 供应商的缓存读取报价确实高于输入价（也有把缓存写入价填进该字段的
 * 情况），静默改写会让命中缓存反而按输入价计费。
 */

import type { CatalogRateMap } from "@/lib/pi-catalog";
import type { UpstreamModelMeta, UpstreamModelPrice } from "@/lib/types";

export interface ResolvedRates {
  inputRate: number;
  outputRate: number;
  cacheReadRate: number;
}

/** 1x 基准上下文：只需基准模型 ID，基准存量倍率按上游各自解析。 */
export interface BaseModelContext {
  modelId: string;
}

/** 倍率有效化：有限且 >= 0 才采纳，其余（含 undefined/null）按 1（不缩放）处理。 */
export function normalizeMultiplier(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 1;
}

function rateOrOne(value: number | undefined): number {
  // 基准倍率缺失或为 0（不计费）都按 1 归一，避免除零 / 倍率爆炸。
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

/** 上游报价有效性：缺省 / 非有限值 / 0 都视为「未返回」，回退目录。 */
function upstreamRate(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * 缓存读取价 ÷ 输入价 的折扣比例：上游报价两者都有时用它（上游自报的
 * 缓存折扣最可信），否则用 pi-catalog 的同一比例，都没有按 1（不收缓存
 * 折扣的供应商即如此）。
 */
function cacheDiscountRatio(
  catalogRate: CatalogRateMap[string] | undefined,
  price: UpstreamModelPrice | undefined,
): number {
  const priceInput = upstreamRate(price?.inputRate);
  const priceCache = upstreamRate(price?.cacheReadRate);
  if (priceInput !== undefined && priceCache !== undefined && priceInput > 0) {
    return priceCache / priceInput;
  }
  if (catalogRate && catalogRate.input > 0) {
    return catalogRate.cacheRead / catalogRate.input;
  }
  return 1;
}

/**
 * 存量 tokenType 倍率的来源链：覆盖自定义值 > 上游 /v1/models 报价 >
 * pi-catalog > 1x。`cacheRead` 缺省时按输入价 × 缓存折扣折算 —— 两套口径
 * 不同，直接取目录里的绝对倍率会得到数倍于输入价的缓存价
 * （如 gemini-3.8-flash 的 0.9375 vs 0.0625）。
 */
export function currentStoredRates(
  model: string,
  stored: UpstreamModelMeta | undefined,
  defaults: CatalogRateMap,
  upstreamPrice?: UpstreamModelPrice | null,
): ResolvedRates {
  const catalogRate = defaults[model];
  const price = upstreamPrice ?? undefined;
  const discount = cacheDiscountRatio(catalogRate, price);
  const devInput = upstreamRate(price?.inputRate) ?? catalogRate?.input ?? 1;
  const devOutput = upstreamRate(price?.outputRate) ?? catalogRate?.output ?? 1;
  // 缓存读取：上游报价优先；缺省按折扣比例折算到实际输入价。
  const devCache = upstreamRate(price?.cacheReadRate) ?? round4(devInput * discount);

  if (stored?.override) {
    const inputRate = stored.inputRate ?? devInput;
    const outputRate = stored.outputRate ?? devOutput;
    const cacheReadRate = stored.cacheReadRate ?? round4(inputRate * discount);
    return { inputRate, outputRate, cacheReadRate };
  }
  return {
    inputRate: devInput,
    outputRate: devOutput,
    cacheReadRate: devCache,
  };
}

/**
 * 按模型解析实际倍率：
 * 实际倍率 = tokenTypeRate ÷ baseRate × modelRate × providerRate。
 * base 为 null（未设基准）= pi-catalog 归一化口径。
 */
export function resolveModelRates(
  upstream: Pick<UpstreamDocLike, "modelMeta" | "modelPrices" | "multiplier">,
  model: string,
  defaults: CatalogRateMap,
  base: BaseModelContext | null = null,
): ResolvedRates {
  const custom: UpstreamModelMeta | undefined = upstream.modelMeta?.[model];
  const stored = currentStoredRates(model, custom, defaults, upstream.modelPrices?.[model]);
  const modelRate = normalizeMultiplier(custom?.multiplier);
  const providerRate = normalizeMultiplier(upstream.multiplier);
  // base == model 时 stored ÷ baseStored 恒为 1，无需特例分支。
  const baseStored = base
    ? currentStoredRates(
        base.modelId,
        upstream.modelMeta?.[base.modelId],
        defaults,
        upstream.modelPrices?.[base.modelId],
      )
    : { inputRate: 1, outputRate: 1, cacheReadRate: 1 };
  const scale = modelRate * providerRate;
  return {
    inputRate: round4(stored.inputRate * scale / rateOrOne(baseStored.inputRate)),
    outputRate: round4(stored.outputRate * scale / rateOrOne(baseStored.outputRate)),
    cacheReadRate: round4(stored.cacheReadRate * scale / rateOrOne(baseStored.cacheReadRate)),
  };
}

/** 解析用的最小上游形状（modelMeta + modelPrices + multiplier 即可）。 */
interface UpstreamDocLike {
  modelMeta?: Record<string, UpstreamModelMeta> | null;
  modelPrices?: Record<string, UpstreamModelPrice> | null;
  multiplier?: number | null;
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
  if (defaults[baseModelId] !== undefined) {
    return { modelId: baseModelId };
  }
  const resolvable = upstreams.some((upstream) => {
    const price = upstream.modelPrices?.[baseModelId];
    if (
      price !== undefined
      && (upstreamRate(price.inputRate) !== undefined
        || upstreamRate(price.outputRate) !== undefined
        || upstreamRate(price.cacheReadRate) !== undefined)
    ) {
      return true;
    }
    const custom = upstream.modelMeta?.[baseModelId];
    return custom?.override === true
      && (upstreamRate(custom.inputRate) !== undefined
        || upstreamRate(custom.outputRate) !== undefined
        || upstreamRate(custom.cacheReadRate) !== undefined);
  });
  return resolvable ? { modelId: baseModelId } : null;
}
