import {
  AvatarReplacementError,
  deleteAgentAvatar,
  getAvatar,
  revertAgentAvatar,
  snapshotAgentAvatar,
  uploadAgentAvatar,
} from "@/lib/avatars";
import { renewAvatarLock, withAvatarLock } from "@/lib/avatar-locks";
import { requireUserSession } from "@/lib/auth";
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

    const avatar = await getAvatar(agent.avatarUrl);
    if (!avatar || avatar.statusCode !== 200 || !avatar.stream) {
      return jsonError("Avatar not found.", 404);
    }

    return new Response(avatar.stream, {
      headers: {
        "Cache-Control": "private, no-cache",
        "Content-Type": avatar.blob.contentType,
        ETag: avatar.blob.etag,
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
    return await withAvatarLock(`agent:${agentId}`, async (lock) => {
      const agent = await getAgentById(session.sub, agentId);
      if (!agent || agent.deleted) {
        return jsonError("Agent not found.", 404);
      }
      const verifyLock = () => renewAvatarLock(lock);
      const backups = await snapshotAgentAvatar(agentId, verifyLock);
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
          verifyLock,
        );
        const avatarVersion = Date.now();
        const version = await updateAgentAvatar(session.sub, agentId, replacement.url, lock, avatarVersion);
        return jsonOk({
          url: new URL(`/api/avatars/agents/${agentId}`, request.url).toString(),
          version,
          avatarVersion,
        });
      } catch (error) {
        const restored = replacement
          ? await revertAgentAvatar(replacement, backups, verifyLock)
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
    return await withAvatarLock(`agent:${agentId}`, async (lock) => {
      const agent = await getAgentById(session.sub, agentId);
      if (!agent || agent.deleted) {
        return jsonError("Agent not found.", 404);
      }
      const version = await updateAgentAvatar(session.sub, agentId, null, lock);
      await deleteAgentAvatar(agentId, () => renewAvatarLock(lock));
      return jsonOk({ url: null, version, avatarVersion: null });
    });
  } catch (error) {
    return storageErrorResponse(error, "Unable to delete the agent avatar.");
  }
}
