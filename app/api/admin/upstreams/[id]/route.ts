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
import { createLogger } from "@/lib/runtime-logs";
import { storageErrorResponse } from "@/lib/route-errors";
import { deleteUpstream, updateUpstream } from "@/lib/storage";
import { upstreamInputSchema } from "@/lib/validation";

export const runtime = "nodejs";

const adminLog = createLogger("admin");

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const { id } = await context.params;
  const parsed = upstreamInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid upstream payload.", 400);
  }

  try {
    const upstream = await updateUpstream(id, parsed.data);
    adminLog.info("Upstream updated.", { adminId: admin.claims.sub, entity: "upstream", entityId: id, name: upstream.name, modelCount: upstream.models?.length ?? 0, enabled: upstream.enabled });
    return jsonOk({ upstream });
  } catch (error) {
    return storageErrorResponse(error, "Unable to update the upstream.");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const { id } = await context.params;
  try {
    await deleteUpstream(id);
    adminLog.info("Upstream deleted.", { adminId: admin.claims.sub, entity: "upstream", entityId: id });
    return jsonOk({ success: true });
  } catch (error) {
    return storageErrorResponse(error, "Unable to delete the upstream.");
  }
}
