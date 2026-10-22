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

import { revokeAuthTokens } from "@/lib/auth-tokens";
import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { createLogger } from "@/lib/runtime-logs";
import { deleteUserSessions } from "@/lib/sessions";
import { hashPassword, verifyPassword } from "@/lib/security";
import { getUserById, updateUserPassword } from "@/lib/storage";
import { passwordChangeSchema } from "@/lib/validation";

export const runtime = "nodejs";

const authLog = createLogger("auth");

export async function PUT(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const parsed = passwordChangeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid password change payload.", 400);
  }

  const user = await getUserById(session.sub);
  if (!user) {
    return jsonError("User not found.", 404);
  }
  if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    authLog.warn("Password change rejected: wrong current password.", { userId: session.sub });
    return jsonError("The current password is incorrect.", 401);
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    authLog.warn("Password change rejected: unchanged.", { userId: session.sub });
    return jsonError("The new password must be different.", 400);
  }

  await updateUserPassword(session.sub, await hashPassword(parsed.data.newPassword));
  // 改密必须让其它设备上的会话失效（否则旧密码泄露后仍能继续用），
  // 当前设备保留：它刚证明了自己知道新密码。
  const revoked = await deleteUserSessions(session.sub, session.sid);
  // 旧的重置链接必须立刻作废（否则改密不能真正止损）；验证链接无害，
  // 留着它，未验证账号改密后不需要再申请一封验证邮件。
  await revokeAuthTokens(session.sub, "reset_password");
  authLog.info("Password changed.", { userId: session.sub, revokedSessions: revoked });
  return jsonOk({ success: true });
}
