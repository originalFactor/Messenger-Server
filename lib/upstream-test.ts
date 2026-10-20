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

/** 上游模型测试（最小对话探活）的共享实现，供表单直测路由使用。 */

import {
  type ApiFormat,
  type IrRequest,
  decodeUpstreamResponse,
  encodeUpstreamRequest,
  formatPath,
  normalizeApiFormat,
  upstreamHeaders,
} from "@/lib/ai-formats";
import { createLogger } from "@/lib/runtime-logs";

const relayLog = createLogger("relay");

export class UpstreamTestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const TEST_TIMEOUT_MS = 30_000;
const MAX_REPLY_LENGTH = 120;

export interface UpstreamTestResult {
  latencyMs: number;
  reply: string;
}

/**
 * 向上游发送一次最小对话，验证指定模型可用性并测量耗时。
 * [apiFormat] 缺省按 OpenAI Chat Completions 探测。
 */
export async function testUpstreamModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  apiFormat?: ApiFormat,
): Promise<UpstreamTestResult> {
  const format = normalizeApiFormat(apiFormat, "chat");
  const url = `${baseUrl.replace(/\/+$/, "")}${formatPath(format)}`;
  const ir: IrRequest = {
    model,
    messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
    maxTokens: 16,
    stream: false,
  };
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: upstreamHeaders(format, apiKey),
      body: JSON.stringify(encodeUpstreamRequest(format, ir)),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch (error) {
    relayLog.warn("Upstream test failed.", { url, model, error: error instanceof Error ? { name: error.name, message: error.message } : error });
    throw new UpstreamTestError("无法连接上游服务，请检查地址与密钥。", 502);
  }
  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as
      | { error?: { message?: unknown } | string; message?: unknown }
      | null;
    const message =
      typeof detail?.error === "string"
        ? detail.error
        : typeof detail?.error?.message === "string"
          ? detail.error.message
          : typeof detail?.message === "string"
            ? detail.message
            : `上游返回 ${response.status}。`;
    relayLog.warn("Upstream test returned non-OK.", { url, model, status: response.status, latencyMs });
    throw new UpstreamTestError(message, 502);
  }

  const payload = await response.json().catch(() => null);
  const reply = payload ? decodeUpstreamResponse(format, payload).text : "";
  const result = { latencyMs, reply: reply.slice(0, MAX_REPLY_LENGTH) };
  relayLog.info("Upstream test succeeded.", { url, model, latencyMs, replyLength: result.reply.length });
  return result;
}
