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

/** 上游 /v1/models 探测的共享实现，供已存上游与表单直探两条路由使用。 */

export class UpstreamProbeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const PROBE_TIMEOUT_MS = 15_000;

export async function fetchUpstreamModelIds(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("Upstream probe failed.", { url, error });
    throw new UpstreamProbeError("无法连接上游服务，请检查地址与密钥。", 502);
  }

  if (!response.ok) {
    throw new UpstreamProbeError(`上游返回 ${response.status}，请检查地址与密钥。`, 502);
  }

  const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
  const data = payload?.data;
  if (!Array.isArray(data)) {
    throw new UpstreamProbeError("上游响应格式不是 OpenAI 兼容的模型列表。", 502);
  }

  return data
    .map((entry) => (entry as { id?: unknown } | null)?.id)
    .filter((value): value is string => typeof value === "string");
}
