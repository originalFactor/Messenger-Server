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
 * 模型广场：对每个可服务模型，逐上游解析生效倍率（与 /v1 代理的
 * resolveModelMeta 语义完全一致 —— tokenTypeRate × modelRate ×
 * providerRate），多上游倍率不一致时聚合为区间展示。
 */

import { getModelDefaults } from "@/lib/model-metadata";
import { type BaseModelContext, resolveModelRates } from "@/lib/model-rates";
import { getModelRateSettings, listEnabledUpstreams } from "@/lib/storage";

export interface PlazaModel {
  modelId: string;
  inputRateMin: number;
  inputRateMax: number;
  outputRateMin: number;
  outputRateMax: number;
  cacheReadRateMin: number;
  cacheReadRateMax: number;
  /** 提供该模型的启用上游数量。 */
  upstreamCount: number;
}

export async function getModelPlaza(): Promise<PlazaModel[]> {
  const [upstreams, defaults, settings] = await Promise.all([
    listEnabledUpstreams(),
    getModelDefaults(),
    getModelRateSettings(),
  ]);
  const baseId = settings.baseModelId;
  const base: BaseModelContext | null =
    baseId !== null && defaults.rates[baseId] !== undefined ? { modelId: baseId } : null;
  const collected = new Map<string, { inputs: number[]; outputs: number[]; cacheReads: number[] }>();
  for (const upstream of upstreams) {
    for (const modelId of upstream.models) {
      // 与 /v1 代理计费同一份解析：override 语义 + modelRate × providerRate。
      const resolved = resolveModelRates(upstream, modelId, defaults.rates, base);
      const entry = collected.get(modelId) ?? { inputs: [], outputs: [], cacheReads: [] };
      entry.inputs.push(resolved.inputRate);
      entry.outputs.push(resolved.outputRate);
      entry.cacheReads.push(resolved.cacheReadRate);
      collected.set(modelId, entry);
    }
  }
  return [...collected.entries()]
    .map(([modelId, entry]) => ({
      modelId,
      inputRateMin: Math.min(...entry.inputs),
      inputRateMax: Math.max(...entry.inputs),
      outputRateMin: Math.min(...entry.outputs),
      outputRateMax: Math.max(...entry.outputs),
      cacheReadRateMin: Math.min(...entry.cacheReads),
      cacheReadRateMax: Math.max(...entry.cacheReads),
      upstreamCount: entry.inputs.length,
    }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}
