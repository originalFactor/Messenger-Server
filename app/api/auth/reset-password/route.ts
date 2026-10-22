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

import { consumeAuthToken, revokeAuthTokens } from "@/lib/auth-tokens";
import { jsonError, jsonOk } from "@/lib/http";
import { clientIp, enforceRateLimits } from "@/lib/rate-limit";
import { storageErrorResponse } from "@/lib/route-errors";
import { createLogger } from "@/lib/runtime-logs";
import { hashPassword } from "@/lib/security";
import { deleteUserSessions } from "@/lib/sessions";
import { getUserById, markEmailVerified, updateUserPassword } from "@/lib/storage";
import { passwordResetSchema } from "@/lib/validation";

export const runtime = "nodejs";

const authLog = createLogger("auth");

/** 令牌空间很大，仍按 IP 限流：阻止有人把这里当 scrypt 压力测试机。 */
const RESET_IP_RULE = { bucket: "reset-password-ip", limit: 20, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request) {
  const parsed = passwordResetSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid password reset payload.", 400);
  }

  const limited = await enforceRateLimits([{ rule: RESET_IP_RULE, identity: clientIp(request) }]);
  if (limited) {
    authLog.warn("Password reset rate limited.", { reason: "rate-limited" });
    return limited;
  }

  // 先消费令牌再算哈希：令牌无效时不做 scrypt，省掉一次 ~50ms 的 CPU。
  const token = await consumeAuthToken(parsed.data.token, "reset_password");
  if (!token) {
    authLog.warn("Password reset rejected: invalid token.", { reason: "invalid-token" });
    return jsonError("This reset link is invalid or has expired. Request a new one.", 400);
  }

  const user = await getUserById(token.userId);
  if (!user) {
    authLog.warn("Password reset rejected: user missing.", { userId: token.userId });
    return jsonError("This reset link is invalid or has expired. Request a new one.", 400);
  }

  try {
    await updateUserPassword(user.id, await hashPassword(parsed.data.password));
  } catch (error) {
    authLog.error("Password reset write failed.", { userId: user.id });
    return storageErrorResponse(error, "Unable to reset the password. Please try again.");
  }

  // 重置密码等于凭据泄漏的最坏情况：踢掉全部设备（含未知设备），并要求
  // 用新密码重新登录。会话不留墓碑，删除即永久失效。
  const revoked = await deleteUserSessions(user.id);
  // 顺手把残留的重置 / 验证令牌一并清掉，旧邮件里的链接全部作废。
  await revokeAuthTokens(user.id);
  // 点开邮件链接本身就证明了对该邮箱的控制权，因此同时完成验证。
  const verifiedAt = Date.now();
  await markEmailVerified(user.id, verifiedAt);

  authLog.info("Password reset completed.", { userId: user.id, revokedSessions: revoked });
  return jsonOk({ success: true, emailVerifiedAt: user.emailVerifiedAt ?? verifiedAt });
}
