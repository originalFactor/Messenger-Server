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
import { upsertModelContexts } from "@/lib/storage";
import { aiModelContextBatchSchema } from "@/lib/validation";

export const runtime = "nodejs";

/** 批量写入模型上下文窗口（上游模型选择器在保存上游时持久化编辑值）。 */
export async function PUT(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const parsed = aiModelContextBatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid model context payload.", 400);
  }

  await upsertModelContexts(
    parsed.data.models.map((model) => ({ modelId: model.id, contextWindow: model.contextWindow })),
  );
  return jsonOk({ success: true });
}
