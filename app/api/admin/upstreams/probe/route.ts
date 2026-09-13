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
import { UpstreamProbeError, fetchUpstreamModelIds } from "@/lib/upstream-probe";
import { upstreamProbeSchema } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * 直接探测上游：不要求上游已保存，表单里填好 Base URL / API Key 即可
 * 拉取其 /v1/models，供「新增/编辑上游」的模型列表勾选。
 */
export async function POST(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const parsed = upstreamProbeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid upstream probe payload.", 400);
  }

  try {
    const models = await fetchUpstreamModelIds(parsed.data.baseUrl, parsed.data.apiKey);
    return jsonOk({ models });
  } catch (error) {
    if (error instanceof UpstreamProbeError) {
      return jsonError(error.message, error.status);
    }
    throw error;
  }
}
