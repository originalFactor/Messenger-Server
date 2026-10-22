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

import { consumeAuthToken } from "@/lib/auth-tokens";
import { jsonError, jsonOk } from "@/lib/http";
import { clientIp, enforceRateLimits } from "@/lib/rate-limit";
import { createLogger } from "@/lib/runtime-logs";
import { getUserById, markEmailVerified } from "@/lib/storage";
import { emailVerificationSchema } from "@/lib/validation";

export const runtime = "nodejs";

const authLog = createLogger("auth");

/** 验证链接是被点击的公开端点：按 IP 限流，避免把令牌空间当接口刷。 */
const VERIFY_IP_RULE = { bucket: "verify-email-ip", limit: 30, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request) {
  const parsed = emailVerificationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid email verification payload.", 400);
  }

  const limited = await enforceRateLimits([{ rule: VERIFY_IP_RULE, identity: clientIp(request) }]);
  if (limited) {
    authLog.warn("Email verification rate limited.", { reason: "rate-limited" });
    return limited;
  }

  // 消费即删除：同一封邮件只能验证一次，重放第二次拿不到文档。
  const token = await consumeAuthToken(parsed.data.token, "verify_email");
  if (!token) {
    authLog.warn("Email verification rejected: invalid token.", { reason: "invalid-token" });
    return jsonError("This verification link is invalid or has expired. Request a new one.", 400);
  }

  const user = await getUserById(token.userId);
  if (!user) {
    authLog.warn("Email verification rejected: user missing.", { userId: token.userId });
    return jsonError("This verification link is invalid or has expired. Request a new one.", 400);
  }

  const verifiedAt = Date.now();
  await markEmailVerified(user.id, verifiedAt);
  authLog.info("Email verified.", { userId: user.id, email: user.email });
  return jsonOk({ success: true, emailVerifiedAt: user.emailVerifiedAt ?? verifiedAt });
}
