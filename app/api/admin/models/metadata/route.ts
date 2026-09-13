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
import { getModelDefaults } from "@/lib/model-metadata";

export const runtime = "nodejs";

/**
 * models.dev 模型元数据（实例内存缓存 24h）：modelId →
 * { contextWindow?, inputRate?, outputRate? }。倍率以
 * deepseek-v4.1-flash 成本为基准归一化；models.dev 不可用时返回空映射。
 */
export async function GET() {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const { contextSizes, rates } = await getModelDefaults();
  const ids = new Set([...Object.keys(contextSizes), ...Object.keys(rates)]);
  const metadata: Record<string, { contextWindow?: number; inputRate?: number; outputRate?: number }> = {};
  for (const modelId of ids) {
    const contextWindow = contextSizes[modelId];
    const rate = rates[modelId];
    if (contextWindow || rate) {
      metadata[modelId] = {
        ...(contextWindow ? { contextWindow } : {}),
        ...(rate ? { inputRate: rate.input, outputRate: rate.output } : {}),
      };
    }
  }
  return jsonOk({ metadata });
}
