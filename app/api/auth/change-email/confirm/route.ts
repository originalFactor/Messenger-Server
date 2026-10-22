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

import { consumeEmailChangeCode, revokeAuthTokens } from "@/lib/auth-tokens";
import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { clientIp, enforceRateLimits } from "@/lib/rate-limit";
import { storageErrorResponse } from "@/lib/route-errors";
import { createLogger } from "@/lib/runtime-logs";
import { getUserById, updateUserEmail } from "@/lib/storage";
import { buildSelfUserView } from "@/lib/user-view";
import { emailChangeConfirmSchema } from "@/lib/validation";

export const runtime = "nodejs";

const authLog = createLogger("auth");

/**
 * 改绑邮箱第二步：用邮件里的 6 位码确认。
 *
 * 验证码空间只有 10^6，所以限流比发信更紧（同账号每小时 10 次、同 IP 30
 * 次）；`consumeEmailChangeCode` 还要求码必须属于「当前用户 + 这个目标
 * 邮箱」，别人的码用不到自己的会话上。
 */
const CONFIRM_IP_RULE = { bucket: "email-change-confirm-ip", limit: 30, windowMs: 60 * 60 * 1000 };
const CONFIRM_USER_RULE = { bucket: "email-change-confirm-user", limit: 10, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const parsed = emailChangeConfirmSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("A valid email and the 6-digit verification code are required.", 400);
  }

  const limited = await enforceRateLimits([
    { rule: CONFIRM_IP_RULE, identity: clientIp(request) },
    { rule: CONFIRM_USER_RULE, identity: session.sub },
  ]);
  if (limited) {
    authLog.warn("Email change confirmation rate limited.", { userId: session.sub, reason: "rate-limited" });
    return limited;
  }

  const user = await getUserById(session.sub);
  if (!user) {
    return jsonError("User not found.", 404);
  }
  if (parsed.data.email === user.email) {
    return jsonError("That is already your email address.", 400);
  }

  // 先消费再写库：验证码一次性，写失败（邮箱被抢注）也不会留下可重放的码。
  const consumed = await consumeEmailChangeCode(session.sub, parsed.data.email, parsed.data.code);
  if (!consumed) {
    authLog.warn("Email change rejected: invalid code.", { userId: session.sub });
    return jsonError("The verification code is invalid or has expired.", 400);
  }

  try {
    await updateUserEmail(session.sub, parsed.data.email);
  } catch (error) {
    return storageErrorResponse(error, "Unable to change the email address.");
  }
  // 旧地址的验证 / 重置链接一律作废：它们证明的是对**旧**邮箱的控制权。
  await revokeAuthTokens(session.sub);

  const updated = await getUserById(session.sub);
  if (!updated) {
    return jsonError("User not found.", 404);
  }
  authLog.info("Email changed.", { userId: session.sub });
  // 会话记录按用户 ID 关联，与邮箱无关，因此改绑不需要重新登录。
  return jsonOk({ user: await buildSelfUserView(updated) });
}
