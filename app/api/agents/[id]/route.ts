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
import { withAvatarLock } from "@/lib/avatar-locks";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import { softDeleteAgent, upsertAgent } from "@/lib/storage";
import { deleteAgentAvatar } from "@/lib/avatars";
import { agentSchema, entityIdSchema } from "@/lib/validation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

async function getAgentId(context: RouteContext): Promise<string | null> {
  const { id } = await context.params;
  return entityIdSchema.safeParse(id).success ? id : null;
}

export async function PUT(request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const agentId = await getAgentId(context);
  if (!agentId) {
    return jsonError("Invalid agent ID.", 400);
  }

  const parsed = agentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid agent payload.", 400);
  }
  if (parsed.data.id !== agentId) {
    return jsonError("The agent ID must match the request path.", 400);
  }

  try {
    const version = await upsertAgent(session.sub, parsed.data);
    return jsonOk({ id: agentId, version });
  } catch (error) {
    return storageErrorResponse(error, "Unable to save the agent.");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const agentId = await getAgentId(context);
  if (!agentId) {
    return jsonError("Invalid agent ID.", 400);
  }

  try {
    return await withAvatarLock(`agent:${agentId}`, async (lock, verify) => {
      const version = await softDeleteAgent(session.sub, agentId, lock);
      await deleteAgentAvatar(agentId, verify);
      return jsonOk({ id: agentId, version });
    });
  } catch (error) {
    return storageErrorResponse(error, "Unable to delete the agent.");
  }
}
