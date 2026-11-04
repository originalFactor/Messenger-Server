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

import { requireAdminUser } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { getUpstreamById, refreshUpstreamModelPrices } from "@/lib/storage";
import { UpstreamProbeError, probeUpstreamModels } from "@/lib/upstream-probe";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 探测已保存的上游：服务端请求上游的 GET /models，返回可用模型 ID 列表，
 * 供控制台勾选与一键导入模型目录；上游自报的报价同时写回该上游文档，
 * 之后解析倍率时优先于 pi-catalog。
 */
export async function POST(_request: Request, context: RouteContext) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const { id } = await context.params;
  try {
    const upstream = await getUpstreamById(id);
    if (!upstream) {
      return jsonError("Upstream not found.", 404);
    }
    const result = await probeUpstreamModels(
      upstream.baseUrl,
      upstream.apiKey,
      upstream.apiFormat === "auto" || !upstream.apiFormat ? undefined : upstream.apiFormat,
    );
    // 报价写回是尽力而为：即便写库失败也应先让管理员看到可勾选的模型列表。
    const refreshed = await refreshUpstreamModelPrices(id, result.prices).catch(() => null);
    return jsonOk({
      upstreamId: upstream._id,
      models: result.models,
      prices: refreshed?.modelPrices ?? result.prices,
    });
  } catch (error) {
    if (error instanceof UpstreamProbeError) {
      return jsonError(error.message, error.status);
    }
    throw error;
  }
}
