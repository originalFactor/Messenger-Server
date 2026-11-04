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
      output_rate?: unknown;
    };
    const value = typeof record.id === "string" ? record.id : record.name;
    if (typeof value !== "string") continue;
    const modelId = value.replace(/^models\//, "");
    if (!modelId) continue;
    models.push(modelId);
    const price: UpstreamModelPrice = {};
    const inputRate = parseRate(record.input_rate);
    const cacheReadRate = parseRate(record.cache_read_rate);
    const outputRate = parseRate(record.output_rate);
    if (inputRate !== undefined) price.inputRate = inputRate;
    if (cacheReadRate !== undefined) price.cacheReadRate = cacheReadRate;
    if (outputRate !== undefined) price.outputRate = outputRate;
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
