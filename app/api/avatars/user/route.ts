import {
  AvatarReplacementError,
  deleteUserAvatar,
  getAvatar,
  revertUserAvatar,
  snapshotUserAvatar,
  uploadUserAvatar,
} from "@/lib/avatars";
import { renewAvatarLock, withAvatarLock } from "@/lib/avatar-locks";
import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import { getUserById, updateUserAvatar } from "@/lib/storage";
import { getAvatarUpload } from "@/lib/validation";

export const runtime = "nodejs";

function userAvatarUrl(request: Request): string {
  return new URL("/api/avatars/user", request.url).toString();
}

export async function GET(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  try {
    const user = await getUserById(session.sub);
    if (!user?.avatarUrl) {
      return jsonError("Avatar not found.", 404);
    }

    const avatar = await getAvatar(user.avatarUrl);
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
    return storageErrorResponse(error, "Unable to load the user avatar.");
  }
}

export async function PUT(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const formData = await request.formData().catch(() => null);
  const avatar = formData ? getAvatarUpload(formData) : null;
  if (!avatar) {
    return jsonError("Upload a JPEG, PNG, WebP, or GIF avatar no larger than 5 MiB.", 400);
  }

  try {
    return await withAvatarLock(`user:${session.sub}`, async (lock) => {
      const user = await getUserById(session.sub);
      if (!user) {
        return jsonError("User not found.", 404);
      }
      const verifyLock = () => renewAvatarLock(lock);
      const backups = await snapshotUserAvatar(session.sub, verifyLock);
      const canRestorePriorAvatar = user.avatarUrl !== null && backups.some((backup) => backup.url === user.avatarUrl);
      let metadataCleared = false;
      let replacement: Awaited<ReturnType<typeof uploadUserAvatar>> | null = null;
      try {
        if (user.avatarUrl) {
          await updateUserAvatar(session.sub, null, lock);
          metadataCleared = true;
        }
        replacement = await uploadUserAvatar(
          session.sub,
          backups,
          Buffer.from(await avatar.file.arrayBuffer()),
          avatar.extension,
          avatar.contentType,
          verifyLock,
        );
        const avatarVersion = Date.now();
        const version = await updateUserAvatar(session.sub, replacement.url, lock, avatarVersion);
        return jsonOk({ url: userAvatarUrl(request), version, avatarVersion });
      } catch (error) {
        const restored = replacement
          ? await revertUserAvatar(replacement, backups, verifyLock)
          : error instanceof AvatarReplacementError && error.restored;
        if (metadataCleared && restored && canRestorePriorAvatar && user.avatarUrl) {
          await updateUserAvatar(session.sub, user.avatarUrl, lock, user.avatarVersion);
        }
        throw error;
      }
    });
  } catch (error) {
    return storageErrorResponse(error, "Unable to update the user avatar.");
  }
}

export async function DELETE() {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  try {
    return await withAvatarLock(`user:${session.sub}`, async (lock) => {
      const user = await getUserById(session.sub);
      if (!user) {
        return jsonError("User not found.", 404);
      }
      const version = await updateUserAvatar(session.sub, null, lock);
      await deleteUserAvatar(session.sub, () => renewAvatarLock(lock));
      return jsonOk({ url: null, version, avatarVersion: null });
    });
  } catch (error) {
    return storageErrorResponse(error, "Unable to delete the user avatar.");
  }
}
