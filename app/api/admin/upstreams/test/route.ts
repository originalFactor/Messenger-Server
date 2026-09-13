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
import { UpstreamTestError, testUpstreamModel } from "@/lib/upstream-test";
import { upstreamTestSchema } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * 直接测试上游模型：不要求上游已保存，表单里填好 Base URL / API Key
 * （编辑已有上游时为预填的存储值）即可对单个模型发一次最小 chat
 * completion，验证可用性并测量耗时。
 */
export async function POST(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const parsed = upstreamTestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid upstream test payload.", 400);
  }

  try {
    const result = await testUpstreamModel(parsed.data.baseUrl, parsed.data.apiKey, parsed.data.model);
    return jsonOk({ model: parsed.data.model, latencyMs: result.latencyMs, reply: result.reply });
  } catch (error) {
    if (error instanceof UpstreamTestError) {
      return jsonError(error.message, error.status);
    }
    throw error;
  }
}
