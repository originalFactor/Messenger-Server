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

import { authenticateAiKey, openAiError } from "@/lib/ai-proxy";
import { jsonOk } from "@/lib/http";
import { getCatalogRates } from "@/lib/pi-catalog";
import { resolveBaseContext, resolveModelCard } from "@/lib/model-rates";
import { getModelRateSettings, listEnabledUpstreams } from "@/lib/storage";

import { resolveUpstreamCapabilities } from "@/lib/model-capabilities";

export const runtime = "nodejs";

/**
 * 模型列表：倍率与该模型的 `/v1/chat/completions` 计费同源
 * （`resolveModelCard`：override 自定义 > 上游 /v1/models 报价 > pi-catalog，
 * 再乘 modelRate × providerRate，并除以 1x 基准）。
 *
 * 每个模型输出四条腿（input / cache_read / cache_write / output）的
 * 最优惠价，以及长上下文阶梯（`tiers`）与峰谷配置（`timeBased`）：
 * 后者是结构性配置，取提供该模型的最优上游那一份，客户端据此预估
 * 实际扣费。模型能力从优先级最高的启用上游逐项覆盖 catalog，随列表下发。
 */
export async function GET(request: Request) {
  const user = await authenticateAiKey(request);
  if (!user) {
    return openAiError("Invalid API key.", 401, { type: "authentication_error", code: "invalid_api_key" });
  }

  const [upstreams, defaults, settings] = await Promise.all([
    listEnabledUpstreams(),
    getCatalogRates(),
    getModelRateSettings(),
  ]);
  const base = resolveBaseContext(settings.baseModelId, defaults.rates, upstreams);
  const now = Math.floor(Date.now() / 1000);

  // 同一模型可能由多个上游提供且价格不同：四条腿各取各自的最小值（最优惠），
  // 阶梯/峰谷取价格最优的那条上游的结构，避免把两套阈值和价格混在一起。
  interface Aggregated {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    tiers?: ReturnType<typeof resolveModelCard>["tiers"];
    timeBased?: ReturnType<typeof resolveModelCard>["timeBased"];
    score: number;
  }
  const collected = new Map<string, Aggregated>();
  const capabilities = resolveUpstreamCapabilities(upstreams, defaults.models);
  for (const upstream of upstreams) {
    for (const modelId of upstream.models) {
      const card = resolveModelCard(upstream, modelId, defaults.rates, base);
      const score = card.input + card.output;
      const existing = collected.get(modelId);
      if (!existing) {
        collected.set(modelId, {
          input: card.input,
          cacheRead: card.cacheRead,
          cacheWrite: card.cacheWrite,
          output: card.output,
          ...(card.tiers ? { tiers: card.tiers } : {}),
          ...(card.timeBased ? { timeBased: card.timeBased } : {}),
          score,
        });
        continue;
      }
      existing.input = Math.min(existing.input, card.input);
      existing.cacheRead = Math.min(existing.cacheRead, card.cacheRead);
      existing.cacheWrite = Math.min(existing.cacheWrite, card.cacheWrite);
      existing.output = Math.min(existing.output, card.output);
      if (score < existing.score) {
        existing.score = score;
        existing.tiers = card.tiers;
        existing.timeBased = card.timeBased;
      }
    }
  }

  return jsonOk({
    object: "list",
    data: [...collected.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([modelId, entry]) => ({
        id: modelId,
        object: "model",
        created: now,
        owned_by: "messenger-cloud",
        display_name: capabilities.get(modelId)?.displayName ?? modelId,
        input_modalities: capabilities.get(modelId)?.inputModalities,
        reasoning: capabilities.get(modelId)?.reasoning,
        reasoning_efforts: capabilities.get(modelId)?.reasoningEfforts,
        context_window: capabilities.get(modelId)?.contextWindow,
        max_output_tokens: capabilities.get(modelId)?.maxOutputTokens,
        supports_temperature: capabilities.get(modelId)?.supportsTemperature ?? true,
        supports_top_p: capabilities.get(modelId)?.supportsTopP ?? true,
        supports_penalties: capabilities.get(modelId)?.supportsPenalties ?? true,
        input_rate: entry.input,
        cache_read_rate: entry.cacheRead,
        cache_write_rate: entry.cacheWrite,
        output_rate: entry.output,
        ...(entry.tiers
          ? {
              tiers: entry.tiers.map((tier) => ({
                input_tokens_above: tier.inputThreshold,
                ...(tier.inputThresholdInclusive ? { input_tokens_above_inclusive: true } : {}),
                input_rate: tier.input,
                cache_read_rate: tier.cacheRead,
                cache_write_rate: tier.cacheWrite,
                output_rate: tier.output,
              })),
            }
          : {}),
        ...(entry.timeBased
          ? {
              time_based: {
                off_peak_multiplier: entry.timeBased.offPeakMultiplier,
                peak_windows: entry.timeBased.peakWindows.map((window) => ({
                  weekdays: window.weekdays,
                  start_minute: window.startMinute,
                  end_minute: window.endMinute,
                })),
              },
            }
          : {}),
      })),
  });
}
