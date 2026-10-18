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

/**
 * 生效倍率解析的唯一事实来源：`/v1` 代理计费、模型广场、`/v1/models`
 * 与控制台展示都走这里，避免四份实现漂移。
 *
 * 两层口径：
 * - 存量倍率（stored）长期保存在 models.dev 归一化空间里，与基准无关：
 *   override 开启用自定义值（缺失字段回退 models.dev），关闭用
 *   models.dev，无数据默认 1x，显式 0 = 不计费。
 * - 实际倍率 = 存量倍率 ÷ 基准模型存量倍率 × modelRate × providerRate。
 *
 * 设了 1x 基准模型 B 时，B 自身恒为 1x（存量 ÷ 自身存量），其余模型
 * （含 override 覆盖条目）的实际倍率按 B 重新归一 —— 基准切换只改解析
 * 口径、不改任何存量数据，因此随时可逆、不产生浮点漂移，模型间的相对
 * 价格关系恒定。未设基准时分母取 1（models.dev 归一化口径）。
 *
 * 缓存读取价高于输入价的报价视为脏数据，夹到输入价。
 */

import type { UpstreamModelMeta } from "@/lib/types";
import type { ModelRateMap } from "@/lib/model-metadata";

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

function clampCacheRead(cacheReadRate: number, inputRate: number): number {
  return cacheReadRate > inputRate ? inputRate : cacheReadRate;
}

function rateOrOne(value: number | undefined): number {
  // 基准倍率缺失或为 0（不计费）都按 1 归一，避免除零 / 倍率爆炸。
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * 存量 tokenType 倍率（不含基准归一、不含 modelRate/providerRate 缩放）：
 * 覆盖开启取自定义值（缺失回退 models.dev），关闭取 models.dev，
 * 无数据按 1x。基准模型自身无显式条目时回退 models.dev —— 与其它模型
 * 用同一口径求值，保证「自身 ÷ 自身 = 1」。
 */
export function currentStoredRates(
  model: string,
  stored: UpstreamModelMeta | undefined,
  defaults: ModelRateMap,
): ResolvedRates {
  const devRate = defaults[model];
  const devInput = devRate?.input ?? 1;
  const devOutput = devRate?.output ?? 1;
  const devCache = devRate?.cacheRead ?? devInput;
  if (stored?.override) {
    const inputRate = stored.inputRate ?? devInput;
    const outputRate = stored.outputRate ?? devOutput;
    const rawCache = stored.cacheReadRate ?? devCache;
    return { inputRate, outputRate, cacheReadRate: clampCacheRead(rawCache, inputRate) };
  }
  return {
    inputRate: devInput,
    outputRate: devOutput,
    cacheReadRate: clampCacheRead(devCache, devInput),
  };
}

/**
 * 按模型解析实际倍率：
 * 实际倍率 = tokenTypeRate ÷ baseRate × modelRate × providerRate。
 * base 为 null（未设基准）= models.dev 归一化口径。
 */
export function resolveModelRates(
  upstream: Pick<UpstreamDocLike, "modelMeta" | "multiplier">,
  model: string,
  defaults: ModelRateMap,
  base: BaseModelContext | null = null,
): ResolvedRates {
  const custom: UpstreamModelMeta | undefined = upstream.modelMeta?.[model];
  const stored = currentStoredRates(model, custom, defaults);
  const modelRate = normalizeMultiplier(custom?.multiplier);
  const providerRate = normalizeMultiplier(upstream.multiplier);
  // base == model 时 stored ÷ baseStored 恒为 1，无需特例分支。
  const baseStored = base
    ? currentStoredRates(base.modelId, upstream.modelMeta?.[base.modelId], defaults)
    : { inputRate: 1, outputRate: 1, cacheReadRate: 1 };
  const scale = modelRate * providerRate;
  return {
    inputRate: round4(stored.inputRate * scale / rateOrOne(baseStored.inputRate)),
    outputRate: round4(stored.outputRate * scale / rateOrOne(baseStored.outputRate)),
    cacheReadRate: round4(stored.cacheReadRate * scale / rateOrOne(baseStored.cacheReadRate)),
  };
}

/** 解析用的最小上游形状（modelMeta + multiplier 即可）。 */
interface UpstreamDocLike {
  modelMeta?: Record<string, UpstreamModelMeta> | null;
  multiplier?: number | null;
}
