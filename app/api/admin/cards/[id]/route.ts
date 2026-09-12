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
import { storageErrorResponse } from "@/lib/route-errors";
import { deleteCard, disableCard } from "@/lib/storage";
import { cardPatchSchema } from "@/lib/validation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const { id } = await context.params;
  const parsed = cardPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid card patch payload.", 400);
  }

  try {
    const card = await disableCard(id);
    return jsonOk({ card });
  } catch (error) {
    return storageErrorResponse(error, "Unable to disable the card key.");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const { id } = await context.params;
  try {
    await deleteCard(id);
    return jsonOk({ success: true });
  } catch (error) {
    return storageErrorResponse(error, "Unable to delete the card key.");
  }
}
