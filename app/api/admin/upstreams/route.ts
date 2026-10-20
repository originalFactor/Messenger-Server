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
import { BlockedUrlError, assertOutboundUrl } from "@/lib/outbound-url";
import { createLogger } from "@/lib/runtime-logs";
import { createUpstream, listUpstreams } from "@/lib/storage";
import { upstreamInputSchema } from "@/lib/validation";

export const runtime = "nodejs";

const adminLog = createLogger("admin");

export async function GET() {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const upstreams = await listUpstreams();
  return jsonOk({ upstreams });
}

export async function POST(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const parsed = upstreamInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid upstream payload.", 400);
  }
  // 保存前校验出站地址：中继会带着密钥请求它，不能指向内网/元数据服务。
  try {
    await assertOutboundUrl(parsed.data.baseUrl);
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      return jsonError(error.message, 400);
    }
    throw error;
  }

  const upstream = await createUpstream(parsed.data);
  adminLog.info("Upstream created.", { adminId: admin.claims.sub, entity: "upstream", entityId: upstream._id, name: upstream.name, modelCount: upstream.models?.length ?? 0, enabled: upstream.enabled });
  return jsonOk({ upstream }, 201);
}
