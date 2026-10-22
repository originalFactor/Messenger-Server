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

import { prepareEmailChangeCode } from "@/lib/auth-mail";
import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { mailEnabled } from "@/lib/mail";
import { clientIp, enforceRateLimits } from "@/lib/rate-limit";
import { createLogger } from "@/lib/runtime-logs";
import { verifyPassword } from "@/lib/security";
import { getUserByEmail, getUserById } from "@/lib/storage";
import { emailChangeRequestSchema } from "@/lib/validation";

export const runtime = "nodejs";

const authLog = createLogger("auth");

/**
 * 改绑邮箱第一步：校验当前密码后，向**新**地址发 6 位验证码。
 *
 * 要密码是因为邮箱是登录身份：只凭一个被盗的会话就把账号改绑到攻击者
 * 邮箱，等于永久接管账号。限流按 IP + 账号双份，否则这里就是免费的发信
 * 放大器（每封都带一个 6 位码，可被穷举）。
 */
const EMAIL_CHANGE_IP_RULE = { bucket: "email-change-ip", limit: 10, windowMs: 60 * 60 * 1000 };
const EMAIL_CHANGE_USER_RULE = { bucket: "email-change-user", limit: 5, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const parsed = emailChangeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("A valid new email and your current password are required.", 400);
  }

  const limited = await enforceRateLimits([
    { rule: EMAIL_CHANGE_IP_RULE, identity: clientIp(request) },
    { rule: EMAIL_CHANGE_USER_RULE, identity: session.sub },
  ]);
  if (limited) {
    authLog.warn("Email change rate limited.", { userId: session.sub, reason: "rate-limited" });
    return limited;
  }

  // SMTP 未配置时如实报错：否则用户会一直等一封永远不会来的验证码。
  if (!mailEnabled()) {
    authLog.warn("Email change rejected: SMTP is not configured.", { userId: session.sub, reason: "smtp-missing" });
    return jsonError("Email delivery is not configured on this server. Contact the administrator.", 503);
  }

  const user = await getUserById(session.sub);
  if (!user) {
    return jsonError("User not found.", 404);
  }
  if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    authLog.warn("Email change rejected: wrong current password.", { userId: session.sub });
    return jsonError("The current password is incorrect.", 401);
  }
  if (parsed.data.email === user.email) {
    return jsonError("That is already your email address.", 400);
  }
  if (await getUserByEmail(parsed.data.email)) {
    authLog.warn("Email change rejected: target email exists.", { userId: session.sub });
    return jsonError("An account with this email already exists.", 409);
  }

  const deliver = await prepareEmailChangeCode(user, parsed.data.email);
  if (!deliver || !(await deliver())) {
    authLog.warn("Email change code delivery failed.", {
      userId: session.sub,
      reason: deliver ? "delivery-failed" : "smtp-missing",
    });
    return jsonError("Unable to send the verification code. Please try again later.", 503);
  }

  authLog.info("Email change code sent.", { userId: session.sub });
  return jsonOk({ success: true, email: parsed.data.email });
}
