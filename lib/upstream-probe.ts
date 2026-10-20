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
import { createLogger } from "@/lib/runtime-logs";

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

/**
 * 拉取上游模型 ID。OpenAI/Anthropic 返回 `{ data: [{ id }] }`，Gemini 返回
 * `{ models: [{ name: "models/…" }] }` —— 两种形状都接受，Gemini 的名称去掉
 * `models/` 前缀后即为请求所用的模型 ID。
 */
export async function fetchUpstreamModelIds(
  baseUrl: string,
  apiKey: string,
  apiFormat?: ApiFormat,
): Promise<string[]> {
  const format = normalizeApiFormat(apiFormat, "chat");
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

  const models = entries
    .map((entry) => {
      const record = (entry ?? {}) as { id?: unknown; name?: unknown };
      const value = typeof record.id === "string" ? record.id : record.name;
      return typeof value === "string" ? value.replace(/^models\//, "") : null;
    })
    .filter((value): value is string => value !== null);
  relayLog.info("Upstream probe succeeded.", { url, modelCount: models.length });
  return models;
}
