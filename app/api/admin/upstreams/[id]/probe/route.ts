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
import { getModelContextSizes } from "@/lib/model-metadata";
import { getUpstreamById } from "@/lib/storage";
import { UpstreamProbeError, fetchUpstreamModelIds } from "@/lib/upstream-probe";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 探测已保存的上游：服务端请求上游的 GET /models，返回可用模型 ID 列表
 * （内联 models.dev 上下文窗口数据），供控制台勾选与一键导入模型目录。
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

  try {
    const models = await fetchUpstreamModelIds(upstream.baseUrl, upstream.apiKey);
    const allSizes = await getModelContextSizes();
    const contextSizes = Object.fromEntries(
      models.map((modelId) => [modelId, allSizes[modelId]]).filter(([, size]) => typeof size === "number"),
    );
    return jsonOk({ upstreamId: upstream._id, models, contextSizes });
  } catch (error) {
    if (error instanceof UpstreamProbeError) {
      return jsonError(error.message, error.status);
    }
    throw error;
  }
}
