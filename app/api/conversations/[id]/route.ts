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

import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import { softDeleteConversation, upsertConversation } from "@/lib/storage";
import { conversationSchema, entityIdSchema } from "@/lib/validation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

async function getConversationId(context: RouteContext): Promise<string | null> {
  const { id } = await context.params;
  return entityIdSchema.safeParse(id).success ? id : null;
}

export async function PUT(request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const conversationId = await getConversationId(context);
  if (!conversationId) {
    return jsonError("Invalid conversation ID.", 400);
  }

  const parsed = conversationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid conversation payload.", 400);
  }
  if (parsed.data.id !== conversationId) {
    return jsonError("The conversation ID must match the request path.", 400);
  }

  try {
    const version = await upsertConversation(session.sub, parsed.data);
    return jsonOk({ id: conversationId, version });
  } catch (error) {
    return storageErrorResponse(error, "Unable to save the conversation.");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const conversationId = await getConversationId(context);
  if (!conversationId) {
    return jsonError("Invalid conversation ID.", 400);
  }

  try {
    const version = await softDeleteConversation(session.sub, conversationId);
    return jsonOk({ id: conversationId, version });
  } catch (error) {
    return storageErrorResponse(error, "Unable to delete the conversation.");
  }
}
