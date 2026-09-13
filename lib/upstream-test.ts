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

/** 上游模型测试（最小 chat completion 探活）的共享实现，供表单直测路由使用。 */

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

/** 向上游发送一次最小 chat completion，验证指定模型可用性并测量耗时。 */
export async function testUpstreamModel(
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<UpstreamTestResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("Upstream test failed.", { url, model, error });
    throw new UpstreamTestError("无法连接上游服务，请检查地址与密钥。", 502);
  }
  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as
      | { error?: { message?: unknown } }
      | null;
    const message = typeof detail?.error?.message === "string" ? detail.error.message : `上游返回 ${response.status}。`;
    throw new UpstreamTestError(message, 502);
  }

  const payload = (await response.json().catch(() => null)) as
    | { choices?: Array<{ message?: { content?: unknown } }> }
    | null;
  const content = payload?.choices?.[0]?.message?.content;
  const reply = typeof content === "string" ? content : "";
  return { latencyMs, reply: reply.slice(0, MAX_REPLY_LENGTH) };
}
