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
 * 模型广场：对每个可服务模型，逐上游解析生效倍率（与 /v1 代理的
 * resolveModelMeta 语义完全一致 —— tokenTypeRate × modelRate ×
 * providerRate），多上游倍率不一致时聚合为区间展示。
 *
 * 展示口径是「峰值基础档」：长上下文阶梯与峰谷系数取决于本次提示总量和
 * 下单时刻，广场只用于横向比较牌价，因此这里只统计「该上游是否带阶梯/
 * 峰谷」，不把阶梯后的价并进区间。
 */

import type { CatalogModelMetadata } from "@/lib/pi-catalog";
import { resolveModelCapabilities } from "@/lib/model-capabilities";
import { getCatalogRates } from "@/lib/pi-catalog";
import { type BaseModelContext, resolveBaseContext, resolveModelCard } from "@/lib/model-rates";
import { getModelRateSettings, listEnabledUpstreams } from "@/lib/storage";

export interface PlazaModel {
  modelId: string;
  displayName: string;
  metadata: CatalogModelMetadata;
  inputRateMin: number;
  inputRateMax: number;
  outputRateMin: number;
  outputRateMax: number;
  cacheReadRateMin: number;
  cacheReadRateMax: number;
  cacheWriteRateMin: number;
  cacheWriteRateMax: number;
  /** 提供该模型的启用上游中，带长上下文阶梯价的数量。 */
  longContextCount: number;
  /** 提供该模型的启用上游中，带峰谷（谷时折扣）配置的数量。 */
  timeBasedCount: number;
  /** 提供该模型的启用上游数量。 */
  upstreamCount: number;
}

export async function getModelPlaza(): Promise<PlazaModel[]> {
  const [upstreams, defaults, settings] = await Promise.all([
    listEnabledUpstreams(),
    getCatalogRates(),
    getModelRateSettings(),
  ]);
  const base: BaseModelContext | null = resolveBaseContext(settings.baseModelId, defaults.rates, upstreams);
  const capabilities = new Map<string, CatalogModelMetadata>();
  const collected = new Map<
    string,
    {
      inputs: number[];
      outputs: number[];
      cacheReads: number[];
      cacheWrites: number[];
      longContext: number;
      timeBased: number;
    }
  >();
  for (const upstream of upstreams) {
    for (const modelId of upstream.models) {
      // 与 /v1 代理计费同一份解析：逐字段覆盖 + modelRate × providerRate。
      if (!capabilities.has(modelId)) capabilities.set(modelId, resolveModelCapabilities(modelId, defaults.models, upstream.modelMeta?.[modelId]));
      const card = resolveModelCard(upstream, modelId, defaults.rates, base);
      const entry = collected.get(modelId) ?? {
        inputs: [],
        outputs: [],
        cacheReads: [],
        cacheWrites: [],
        longContext: 0,
        timeBased: 0,
      };
      entry.inputs.push(card.input);
      entry.outputs.push(card.output);
      entry.cacheReads.push(card.cacheRead);
      entry.cacheWrites.push(card.cacheWrite);
      if (card.tiers && card.tiers.length > 0) {
        entry.longContext += 1;
      }
      if (card.timeBased) {
        entry.timeBased += 1;
      }
      collected.set(modelId, entry);
    }
  }
  return [...collected.entries()]
    .map(([modelId, entry]) => ({
      modelId,
      displayName: capabilities.get(modelId)?.displayName ?? modelId,
      metadata: capabilities.get(modelId)!,
      inputRateMin: Math.min(...entry.inputs),
      inputRateMax: Math.max(...entry.inputs),
      outputRateMin: Math.min(...entry.outputs),
      outputRateMax: Math.max(...entry.outputs),
      cacheReadRateMin: Math.min(...entry.cacheReads),
      cacheReadRateMax: Math.max(...entry.cacheReads),
      cacheWriteRateMin: Math.min(...entry.cacheWrites),
      cacheWriteRateMax: Math.max(...entry.cacheWrites),
      longContextCount: entry.longContext,
      timeBasedCount: entry.timeBased,
      upstreamCount: entry.inputs.length,
    }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}
