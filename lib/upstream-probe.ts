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

/** 上游 /models 探测的共享实现，供已存上游与表单直探两条路由使用。 */

import { type ApiFormat, MODELS_PATH, normalizeApiFormat, upstreamHeaders } from "@/lib/ai-formats";
import { BlockedUrlError, assertOutboundUrl } from "@/lib/outbound-url";
import { createLogger } from "@/lib/runtime-logs";
import type { UpstreamModelPrice } from "@/lib/types";

const relayLog = createLogger("relay");

export class UpstreamProbeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const PROBE_TIMEOUT_MS = 15_000;

export interface UpstreamProbeResult {
  /** 上游可服务的模型 ID（Gemini 的 `models/` 前缀已去掉）。 */
  models: string[];
  /**
   * 上游 `/v1/models` 自报的报价（倍率口径），仅含至少返回了一个有效
   * 字段的模型。大多数上游不返回这些扩展字段，此时为空对象。
   */
  prices: Record<string, UpstreamModelPrice>;
}

/** 报价字段解析：只接受有限正数（0 / 负数 / 非数字 = 未返回）。 */
function parseRate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 长上下文阶梯：接受本站导出形状（`input_tokens_above`）与内部形状（`inputThreshold`）。 */
function parseTiers(value: unknown): UpstreamModelPrice["tiers"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tiers = value
    .map((raw) => {
      const record = (raw ?? {}) as Record<string, unknown>;
      const threshold = parsePositiveInt(record.input_tokens_above ?? record.inputThreshold);
      if (threshold === undefined) {
        return null;
      }
      const tier: NonNullable<UpstreamModelPrice["tiers"]>[number] = { inputThreshold: threshold };
      const inclusive = record.input_tokens_above_inclusive ?? record.inputThresholdInclusive;
      if (typeof inclusive === "boolean") {
        tier.inputThresholdInclusive = inclusive;
      }
      const input = parseRate(record.input_rate ?? record.inputRate);
      const output = parseRate(record.output_rate ?? record.outputRate);
      const cacheRead = parseRate(record.cache_read_rate ?? record.cacheReadRate);
      const cacheWrite = parseRate(record.cache_write_rate ?? record.cacheWriteRate);
      if (input !== undefined) tier.inputRate = input;
      if (output !== undefined) tier.outputRate = output;
      if (cacheRead !== undefined) tier.cacheReadRate = cacheRead;
      if (cacheWrite !== undefined) tier.cacheWriteRate = cacheWrite;
      return tier;
    })
    .filter((tier): tier is NonNullable<UpstreamModelPrice["tiers"]>[number] => tier !== null);
  return tiers.length > 0 ? tiers.sort((a, b) => a.inputThreshold - b.inputThreshold) : undefined;
}

/** 峰谷配置：接受本站导出形状（`off_peak_multiplier` / `peak_windows`）与内部驼峰。 */
function parseTimeBased(value: unknown): UpstreamModelPrice["timeBased"] {
  const record = (value ?? null) as Record<string, unknown> | null;
  if (!record || typeof record !== "object") {
    return undefined;
  }
  const multiplier = record.off_peak_multiplier ?? record.offPeakMultiplier;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier < 0) {
    return undefined;
  }
  const rawWindows = record.peak_windows ?? record.peakWindows;
  if (!Array.isArray(rawWindows)) {
    return undefined;
  }
  const windows = rawWindows
    .map((raw) => {
      const window = (raw ?? {}) as Record<string, unknown>;
      const weekdays = Array.isArray(window.weekdays)
        ? window.weekdays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6)
        : [];
      const startMinute = parsePositiveInt(window.start_minute ?? window.startMinute);
      const endMinute = parsePositiveInt(window.end_minute ?? window.endMinute);
      if (weekdays.length === 0 || startMinute === undefined || endMinute === undefined) {
        return null;
      }
      if (startMinute >= endMinute || endMinute > 24 * 60) {
        return null;
      }
      return { weekdays, startMinute, endMinute };
    })
    .filter((window): window is { weekdays: number[]; startMinute: number; endMinute: number } => window !== null);
  return windows.length > 0 ? { offPeakMultiplier: multiplier, peakWindows: windows } : undefined;
}

function parsePositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 拉取上游模型 ID 及其自报报价。OpenAI/Anthropic 返回 `{ data: [{ id }] }`，
 * Gemini 返回 `{ models: [{ name: "models/…" }] }` —— 两种形状都接受，
 * Gemini 的名称去掉 `models/` 前缀后即为请求所用的模型 ID。
 *
 * 报价按本站 `/v1/models` 的字段名读取（`input_rate` / `cache_read_rate` /
 * `output_rate`，倍率口径）；缺失或为 0 的字段留空，解析时回退 pi-catalog。
 *
 * 地址先校验 URL 与 HTTP(S) 协议；允许管理员配置内网上游。
 */
export async function probeUpstreamModels(
  baseUrl: string,
  apiKey: string,
  apiFormat?: ApiFormat,
): Promise<UpstreamProbeResult> {
  const format = normalizeApiFormat(apiFormat, "chat");
  try {
    await assertOutboundUrl(baseUrl);
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      throw new UpstreamProbeError(error.message, 400);
    }
    throw error;
  }
  const url = `${baseUrl.replace(/\/+$/, "")}${MODELS_PATH}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: upstreamHeaders(format, apiKey),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    relayLog.warn("Upstream probe failed.", { url, error: error instanceof Error ? { name: error.name, message: error.message } : error });
    throw new UpstreamProbeError("无法连接上游服务，请检查地址与密钥。", 502);
  }

  if (!response.ok) {
    relayLog.warn("Upstream probe returned non-OK.", { url, status: response.status });
    throw new UpstreamProbeError(`上游返回 ${response.status}，请检查地址与密钥。`, 502);
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: unknown; models?: unknown }
    | null;
  const entries = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : null;
  if (!entries) {
    throw new UpstreamProbeError("上游响应格式不是可识别的模型列表。", 502);
  }

  const fetchedAt = Date.now();
  const models: string[] = [];
  const prices: Record<string, UpstreamModelPrice> = {};
  for (const entry of entries) {
    const record = (entry ?? {}) as {
      id?: unknown;
      name?: unknown;
      input_rate?: unknown;
      cache_read_rate?: unknown;
      cache_write_rate?: unknown;
      cacheWriteRate?: unknown;
      output_rate?: unknown;
      tiers?: unknown;
      time_based?: unknown;
      timeBased?: unknown;
    };
    const value = typeof record.id === "string" ? record.id : record.name;
    if (typeof value !== "string") continue;
    const modelId = value.replace(/^models\//, "");
    if (!modelId) continue;
    models.push(modelId);
    const price: UpstreamModelPrice = {};
    const inputRate = parseRate(record.input_rate);
    const cacheReadRate = parseRate(record.cache_read_rate);
    const cacheWriteRate = parseRate(record.cache_write_rate ?? record.cacheWriteRate);
    const outputRate = parseRate(record.output_rate);
    if (inputRate !== undefined) price.inputRate = inputRate;
    if (cacheReadRate !== undefined) price.cacheReadRate = cacheReadRate;
    if (cacheWriteRate !== undefined) price.cacheWriteRate = cacheWriteRate;
    if (outputRate !== undefined) price.outputRate = outputRate;
    // 长上下文阶梯与峰谷是可选的扩展：上游给了就整份采用，解析时覆盖目录配置。
    const tiers = parseTiers(record.tiers);
    if (tiers) price.tiers = tiers;
    const timeBased = parseTimeBased(record.time_based ?? record.timeBased);
    if (timeBased) price.timeBased = timeBased;
    if (Object.keys(price).length > 0) {
      price.fetchedAt = fetchedAt;
      prices[modelId] = price;
    }
  }
  relayLog.info("Upstream probe succeeded.", {
    url,
    modelCount: models.length,
    pricedModelCount: Object.keys(prices).length,
  });
  return { models, prices };
}
