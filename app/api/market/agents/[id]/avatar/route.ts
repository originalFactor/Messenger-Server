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
  deleteMarketAgentAvatar,
  fetchAvatarWithConditional,
  revertMarketAgentAvatar,
  snapshotMarketAgentAvatar,
  uploadMarketAgentAvatar,
} from "@/lib/avatars";
import { requireUserSession } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import { getMarketAgent, updateMarketAgentAvatar } from "@/lib/storage";
import { entityIdSchema, getAvatarUpload } from "@/lib/validation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

async function marketAgentId(context: RouteContext): Promise<string | null> {
  const { id } = await context.params;
  return entityIdSchema.safeParse(id).success ? id : null;
}

export async function GET(request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) return jsonError("Unauthorized.", 401);
  const id = await marketAgentId(context);
  if (!id) return jsonError("Invalid market agent ID.", 400);

  try {
    const agent = await getMarketAgent(id);
    if (!agent?.avatarUrl) return jsonError("Avatar not found.", 404);
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
    if (!avatar.stream) return jsonError("Avatar not found.", 404);
    return new Response(avatar.stream, {
      headers: {
        "Cache-Control": "private, no-cache",
        "Content-Type": avatar.contentType ?? "application/octet-stream",
        ETag: avatar.etag,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return storageErrorResponse(error, "Unable to load the market avatar.");
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) return jsonError("Unauthorized.", 401);
  const id = await marketAgentId(context);
  if (!id) return jsonError("Invalid market agent ID.", 400);
  const formData = await request.formData().catch(() => null);
  const avatar = formData ? getAvatarUpload(formData) : null;
  if (!avatar) return jsonError("Upload a JPEG, PNG, WebP, or GIF avatar no larger than 5 MiB.", 400);

  try {
    const agent = await getMarketAgent(id);
    if (!agent || agent.ownerUserId !== session.sub) return jsonError("Market Agent not found.", 404);
    const backups = await snapshotMarketAgentAvatar(id);
    const canRestore = agent.avatarUrl !== null && backups.some((backup) => backup.url === agent.avatarUrl);
    let metadataCleared = false;
    let replacement: Awaited<ReturnType<typeof uploadMarketAgentAvatar>> | null = null;
    try {
      if (agent.avatarUrl) {
        await updateMarketAgentAvatar(session.sub, id, null);
        metadataCleared = true;
      }
      replacement = await uploadMarketAgentAvatar(
        id,
        backups,
        Buffer.from(await avatar.file.arrayBuffer()),
        avatar.extension,
        avatar.contentType,
      );
      const updated = await updateMarketAgentAvatar(session.sub, id, replacement.url);
      return jsonOk({ url: appUrl(`/api/market/agents/${id}/avatar`), version: updated.version, avatarVersion: updated.avatarVersion });
    } catch (error) {
      const restored = replacement
        ? await revertMarketAgentAvatar(replacement, backups)
        : error instanceof AvatarReplacementError && error.restored;
      if (metadataCleared && restored && canRestore && agent.avatarUrl) {
        await updateMarketAgentAvatar(session.sub, id, agent.avatarUrl);
      }
      throw error;
    }
  } catch (error) {
    return storageErrorResponse(error, "Unable to update the market avatar.");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) return jsonError("Unauthorized.", 401);
  const id = await marketAgentId(context);
  if (!id) return jsonError("Invalid market agent ID.", 400);

  try {
    const agent = await getMarketAgent(id);
    if (!agent || agent.ownerUserId !== session.sub) return jsonError("Market Agent not found.", 404);
    const updated = await updateMarketAgentAvatar(session.sub, id, null);
    await deleteMarketAgentAvatar(id);
    return jsonOk({ url: null, version: updated.version, avatarVersion: null });
  } catch (error) {
    return storageErrorResponse(error, "Unable to delete the market avatar.");
  }
}
