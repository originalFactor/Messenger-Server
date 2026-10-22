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
import { prepareVerificationEmail } from "@/lib/auth-mail";
import { jsonError, jsonOk } from "@/lib/http";
import { clientIp, enforceRateLimits } from "@/lib/rate-limit";
import { createLogger } from "@/lib/runtime-logs";
import { getUserById } from "@/lib/storage";

export const runtime = "nodejs";

const authLog = createLogger("auth");

/** 重发是登录态操作，但每封都是一次出信：按 IP + 账号双重限流。 */
const RESEND_IP_RULE = { bucket: "verify-resend-ip", limit: 10, windowMs: 60 * 60 * 1000 };
const RESEND_USER_RULE = { bucket: "verify-resend-user", limit: 5, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const limited = await enforceRateLimits([
    { rule: RESEND_IP_RULE, identity: clientIp(request) },
    { rule: RESEND_USER_RULE, identity: session.sub },
  ]);
  if (limited) {
    authLog.warn("Verification resend rate limited.", { userId: session.sub, reason: "rate-limited" });
    return limited;
  }

  const user = await getUserById(session.sub);
  if (!user) {
    return jsonError("User not found.", 404);
  }
  if (user.emailVerifiedAt !== null) {
    // 已验证的账号不再发信：既省一次投递，也让界面能直接收起提醒。
    return jsonOk({ success: true, alreadyVerified: true, emailVerifiedAt: user.emailVerifiedAt, sent: false });
  }

  const deliver = await prepareVerificationEmail(user);
  if (!deliver || !(await deliver())) {
    authLog.warn("Verification resend failed.", {
      userId: user.id,
      reason: deliver ? "delivery-failed" : "smtp-missing",
    });
    return jsonError("Unable to send the verification email. Please try again later.", 503);
  }
  return jsonOk({ success: true, alreadyVerified: false, sent: true });
}
