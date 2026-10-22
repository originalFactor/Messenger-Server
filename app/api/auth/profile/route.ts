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

import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import { createLogger } from "@/lib/runtime-logs";
import { getUserById, updateUserDisplayName } from "@/lib/storage";
import { buildSelfUserView } from "@/lib/user-view";
import { profileUpdateSchema } from "@/lib/validation";

export const runtime = "nodejs";

const authLog = createLogger("auth");

/**
 * 用户中心资料（昵称）。邮箱与密码各有专门端点：改邮箱要验证新地址，
 * 改密码要踢掉其它设备，语义完全不同，不塞进同一个 PATCH。
 *
 * 头像不在 JSON 里改：`PUT /api/avatars/user` 是 App 与网页共用的上传
 * 通道，走那里才能复用 Blob 快照/回滚与头像锁。
 */
export async function PUT(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const parsed = profileUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Nickname must be 1-32 characters.", 400);
  }

  try {
    await updateUserDisplayName(session.sub, parsed.data.displayName);
  } catch (error) {
    return storageErrorResponse(error, "Unable to update the profile.");
  }

  const user = await getUserById(session.sub);
  if (!user) {
    return jsonError("User not found.", 404);
  }
  authLog.info("Profile updated.", { userId: session.sub, displayNameSet: parsed.data.displayName !== null });
  // 返回完整自视视图：客户端把它当成账号快照替换，不必再拉一次 /me。
  return jsonOk({ user: await buildSelfUserView(user) });
}
