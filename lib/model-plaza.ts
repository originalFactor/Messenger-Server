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
 * resolveModelMeta 语义完全一致 —— override 开启用自定义值（缺失回退
 * models.dev），关闭用 models.dev，无数据置零），多上游倍率不一致时
 * 聚合为区间展示。
 */

import { getModelDefaults } from "@/lib/model-metadata";
import { listEnabledUpstreams } from "@/lib/storage";

export interface PlazaModel {
  modelId: string;
  /** 各上游生效上下文的最大值（0 = 不限）。 */
  contextWindow: number;
  inputRateMin: number;
  inputRateMax: number;
  outputRateMin: number;
  outputRateMax: number;
  /** 提供该模型的启用上游数量。 */
  upstreamCount: number;
}

export async function getModelPlaza(): Promise<PlazaModel[]> {
  const [upstreams, defaults] = await Promise.all([listEnabledUpstreams(), getModelDefaults()]);
  const collected = new Map<string, { contexts: number[]; inputs: number[]; outputs: number[] }>();
  for (const upstream of upstreams) {
    for (const modelId of upstream.models) {
      const devContext = defaults.contextSizes[modelId];
      const devRate = defaults.rates[modelId];
      const custom = upstream.modelMeta?.[modelId];
      const resolved = custom?.override
        ? {
            contextWindow: custom.contextWindow ?? devContext ?? 0,
            inputRate: custom.inputRate ?? devRate?.input ?? 0,
            outputRate: custom.outputRate ?? devRate?.output ?? 0,
          }
        : {
            contextWindow: devContext ?? 0,
            inputRate: devRate?.input ?? 0,
            outputRate: devRate?.output ?? 0,
          };
      const entry = collected.get(modelId) ?? { contexts: [], inputs: [], outputs: [] };
      entry.contexts.push(resolved.contextWindow);
      entry.inputs.push(resolved.inputRate);
      entry.outputs.push(resolved.outputRate);
      collected.set(modelId, entry);
    }
  }
  return [...collected.entries()]
    .map(([modelId, entry]) => ({
      modelId,
      contextWindow: Math.max(...entry.contexts),
      inputRateMin: Math.min(...entry.inputs),
      inputRateMax: Math.max(...entry.inputs),
      outputRateMin: Math.min(...entry.outputs),
      outputRateMax: Math.max(...entry.outputs),
      upstreamCount: entry.inputs.length,
    }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}
