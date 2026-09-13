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
import { importAiModels, listAiModels } from "@/lib/storage";
import { aiModelImportSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function GET() {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const models = await listAiModels();
  return jsonOk({ models });
}

/** 批量导入模型目录（已存在的保持原倍率，新模型默认 1.0 倍率并启用；
 * 上下文窗口在服务端从 models.dev 元数据填充）。 */
export async function POST(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const parsed = aiModelImportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid model import payload.", 400);
  }

  const contextSizes = await getModelContextSizes();
  const models = await importAiModels(parsed.data.modelIds, contextSizes);
  return jsonOk({ models }, 201);
}
