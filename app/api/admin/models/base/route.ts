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
import { currentStoredRates } from "@/lib/model-rates";
import { getModelRateSettings, listUpstreams, setBaseModel } from "@/lib/storage";
import { baseModelInputSchema } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * 1x 基准模型设置：GET 返回当前基准与可候选模型（启用上游可服务模型的并集，
 * 附带各自当前生效的输入/缓存/输出倍率）；PUT 切换基准，全量重算所有上游
 * 已存的 tokenType 倍率（含覆盖条目）后写回。
 */
export async function GET() {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const [settings, upstreams, defaults] = await Promise.all([
    getModelRateSettings(),
    listUpstreams(),
    getModelDefaults(),
  ]);
  const modelIds = [...new Set(upstreams.filter((u) => u.enabled).flatMap((u) => u.models))].sort((a, b) =>
    a.localeCompare(b),
  );
  const rates: Record<string, { inputRate: number; cacheReadRate: number; outputRate: number }> = {};
  for (const modelId of modelIds) {
    // 基准口径 = 当前生效的存量 tokenType 倍率（不含 model/provider 倍率）。
    const stored = currentStoredRates(modelId, undefined, defaults.rates);
    rates[modelId] = {
      inputRate: stored.inputRate,
      cacheReadRate: stored.cacheReadRate,
      outputRate: stored.outputRate,
    };
  }
  return jsonOk({
    baseModelId: settings.baseModelId,
    models: modelIds,
    rates,
  });
}

export async function PUT(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const parsed = baseModelInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid base model payload.", 400);
  }

  const settings = await setBaseModel({ baseModelId: parsed.data.baseModelId });
  return jsonOk({ baseModelId: settings.baseModelId });
}
