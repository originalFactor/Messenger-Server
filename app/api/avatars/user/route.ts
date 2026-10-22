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

import {
  AvatarReplacementError,
  type AvatarReplacement,
  deleteUserAvatar,
  fetchAvatarWithConditional,
  revertUserAvatar,
  snapshotUserAvatar,
  uploadUserAvatar,
} from "@/lib/avatars";
import { withAvatarLock } from "@/lib/avatar-locks";
import { requireUserSession } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { createLogger } from "@/lib/runtime-logs";
import { storageErrorResponse } from "@/lib/route-errors";
import { getUserById, updateUserAvatar } from "@/lib/storage";
import { getAvatarUpload } from "@/lib/validation";

export const runtime = "nodejs";

const avatarLog = createLogger("avatar");

function userAvatarUrl(): string {
  return appUrl("/api/avatars/user");
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

    const ifNoneMatch = request.headers.get("if-none-match");
    const avatar = await fetchAvatarWithConditional(user.avatarUrl, ifNoneMatch);
    // null = DB 记着头像但 Blob 不在了：回 404 让客户端回落到默认头像。
    if (!avatar) {
      return jsonError("Avatar not found.", 404);
    }
    if (avatar.statusCode === 304) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: avatar.etag,
          "Cache-Control": "private, no-cache",
        },
      });
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
    return await withAvatarLock(`user:${session.sub}`, async (lock, verify) => {
      const user = await getUserById(session.sub);
      if (!user) {
        return jsonError("User not found.", 404);
      }
      const backups = await snapshotUserAvatar(session.sub, verify);
      const canRestorePriorAvatar = user.avatarUrl !== null && backups.some((backup) => backup.url === user.avatarUrl);
      let metadataCleared = false;
      let replacement: AvatarReplacement | null = null;
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
          verify,
        );
        const avatarVersion = Date.now();
        const version = await updateUserAvatar(session.sub, replacement.url, lock, avatarVersion);
        avatarLog.info("User avatar updated.", { userId: session.sub, version, avatarVersion, contentType: avatar.contentType });
        return jsonOk({ url: userAvatarUrl(), version, avatarVersion });
      } catch (error) {
        const restored = replacement
          ? await revertUserAvatar(replacement, backups, verify)
          : error instanceof AvatarReplacementError && error.restored;
        if (metadataCleared && restored && canRestorePriorAvatar && user.avatarUrl) {
          await updateUserAvatar(session.sub, user.avatarUrl, lock, user.avatarVersion);
        }
        avatarLog.warn("User avatar replacement failed.", { userId: session.sub, restored, reason: error instanceof Error ? error.message : String(error) });
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
    return await withAvatarLock(`user:${session.sub}`, async (lock, verify) => {
      const user = await getUserById(session.sub);
      if (!user) {
        return jsonError("User not found.", 404);
      }
      const version = await updateUserAvatar(session.sub, null, lock);
      await deleteUserAvatar(session.sub, verify);
      avatarLog.info("User avatar deleted.", { userId: session.sub, version });
      return jsonOk({ url: null, version, avatarVersion: null });
    });
  } catch (error) {
    return storageErrorResponse(error, "Unable to delete the user avatar.");
  }
}
