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

import { requireAdminUser } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { getUpstreamById } from "@/lib/storage";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 探测上游：服务端请求上游的 GET /models，返回可用模型 ID 列表，
 * 供控制台一键导入模型目录。
 */
export async function POST(_request: Request, context: RouteContext) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const { id } = await context.params;
  const upstream = await getUpstreamById(id);
  if (!upstream) {
    return jsonError("Upstream not found.", 404);
  }

  const url = `${upstream.baseUrl.replace(/\/+$/, "")}/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${upstream.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error("Upstream probe failed.", { upstreamId: id, url, error });
    return jsonError("无法连接上游服务，请检查地址与密钥。", 502);
  }

  if (!response.ok) {
    return jsonError(`上游返回 ${response.status}，请检查地址与密钥。`, 502);
  }

  const payload = await response.json().catch(() => null);
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    return jsonError("上游响应格式不是 OpenAI 兼容的模型列表。", 502);
  }

  const modelIds = data
    .map((entry) => (entry as { id?: unknown } | null)?.id)
    .filter((value): value is string => typeof value === "string");

  return jsonOk({ upstreamId: upstream._id, models: modelIds });
}
