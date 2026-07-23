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

import {
  AvatarReplacementError,
  deleteAgentAvatar,
  fetchAvatarWithConditional,
  revertAgentAvatar,
  snapshotAgentAvatar,
  uploadAgentAvatar,
} from "@/lib/avatars";
import { withAvatarLock } from "@/lib/avatar-locks";
import { requireUserSession } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import { getAgentById, updateAgentAvatar } from "@/lib/storage";
import { entityIdSchema, getAvatarUpload } from "@/lib/validation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ agentId: string }> };

async function getAgentId(context: RouteContext): Promise<string | null> {
  const { agentId } = await context.params;
  return entityIdSchema.safeParse(agentId).success ? agentId : null;
}

export async function GET(request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const agentId = await getAgentId(context);
  if (!agentId) {
    return jsonError("Invalid agent ID.", 400);
  }

  try {
    const agent = await getAgentById(session.sub, agentId);
    if (!agent || agent.deleted || !agent.avatarUrl) {
      return jsonError("Avatar not found.", 404);
    }

    const ifNoneMatch = request.headers.get("if-none-match");
    const avatar = await fetchAvatarWithConditional(agent.avatarUrl, ifNoneMatch);
    if (avatar.statusCode === 304) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: avatar.etag,
          "Cache-Control": "private, no-cache",
        },
      });
    }
    if (!avatar.stream) {
      return jsonError("Avatar not found.", 404);
    }

    return new Response(avatar.stream, {
      headers: {
        "Cache-Control": "private, no-cache",
        "Content-Type": avatar.contentType ?? "application/octet-stream",
        ETag: avatar.etag,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return storageErrorResponse(error, "Unable to load the agent avatar.");
  }
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

  const formData = await request.formData().catch(() => null);
  const avatar = formData ? getAvatarUpload(formData) : null;
  if (!avatar) {
    return jsonError("Upload a JPEG, PNG, WebP, or GIF avatar no larger than 5 MiB.", 400);
  }

  try {
    return await withAvatarLock(`agent:${agentId}`, async (lock, verify) => {
      const agent = await getAgentById(session.sub, agentId);
      if (!agent || agent.deleted) {
        return jsonError("Agent not found.", 404);
      }
      const backups = await snapshotAgentAvatar(agentId, verify);
      const canRestorePriorAvatar = agent.avatarUrl !== null && backups.some((backup) => backup.url === agent.avatarUrl);
      let metadataCleared = false;
      let replacement: Awaited<ReturnType<typeof uploadAgentAvatar>> | null = null;
      try {
        if (agent.avatarUrl) {
          await updateAgentAvatar(session.sub, agentId, null, lock);
          metadataCleared = true;
        }
        replacement = await uploadAgentAvatar(
          agentId,
          backups,
          Buffer.from(await avatar.file.arrayBuffer()),
          avatar.extension,
          avatar.contentType,
          verify,
        );
        const avatarVersion = Date.now();
        const version = await updateAgentAvatar(session.sub, agentId, replacement.url, lock, avatarVersion);
        return jsonOk({
          url: appUrl(`/api/avatars/agents/${agentId}`),
          version,
          avatarVersion,
        });
      } catch (error) {
        const restored = replacement
          ? await revertAgentAvatar(replacement, backups, verify)
          : error instanceof AvatarReplacementError && error.restored;
        if (metadataCleared && restored && canRestorePriorAvatar && agent.avatarUrl) {
          await updateAgentAvatar(session.sub, agentId, agent.avatarUrl, lock, agent.avatarVersion);
        }
        throw error;
      }
    });
  } catch (error) {
    return storageErrorResponse(error, "Unable to update the agent avatar.");
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
      const agent = await getAgentById(session.sub, agentId);
      if (!agent || agent.deleted) {
        return jsonError("Agent not found.", 404);
      }
      const version = await updateAgentAvatar(session.sub, agentId, null, lock);
      await deleteAgentAvatar(agentId, verify);
      return jsonOk({ url: null, version, avatarVersion: null });
    });
  } catch (error) {
    return storageErrorResponse(error, "Unable to delete the agent avatar.");
  }
}
