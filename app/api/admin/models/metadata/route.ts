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

export const runtime = "nodejs";

/**
 * 模型元数据（来自 models.dev/models.json，实例内存缓存 24h）：
 * 返回 modelId → { contextWindow } 的映射，供控制台展示上下文大小。
 * models.dev 不可用时返回空映射，不影响页面功能。
 */
export async function GET() {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const contextSizes = await getModelContextSizes();
  return jsonOk({
    metadata: Object.fromEntries(
      Object.entries(contextSizes).map(([modelId, contextWindow]) => [modelId, { contextWindow }]),
    ),
  });
}
