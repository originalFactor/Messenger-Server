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

import { preparePasswordResetEmail } from "@/lib/auth-mail";
import { jsonError, jsonOk } from "@/lib/http";
import { mailEnabled } from "@/lib/mail";
import { clientIp, enforceRateLimits } from "@/lib/rate-limit";
import { createLogger } from "@/lib/runtime-logs";
import { getUserByEmail } from "@/lib/storage";
import { forgotPasswordSchema } from "@/lib/validation";

export const runtime = "nodejs";

const authLog = createLogger("auth");

/**
 * 同 IP 每小时 5 次、同邮箱每小时 3 次。按邮箱限流是必需的：没有它，
 * 这个端点就成了「给任意邮箱发重置邮件」的免费放大器。
 */
const FORGOT_IP_RULE = { bucket: "forgot-password-ip", limit: 5, windowMs: 60 * 60 * 1000 };
const FORGOT_EMAIL_RULE = { bucket: "forgot-password-email", limit: 3, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request) {
  const parsed = forgotPasswordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid password reset request payload.", 400);
  }

  // SMTP 未配置时如实报错：否则用户会一直等一封永远不会来的邮件。
  if (!mailEnabled()) {
    authLog.warn("Password reset rejected: SMTP is not configured.", { reason: "smtp-missing" });
    return jsonError("Email delivery is not configured on this server. Contact the administrator.", 503);
  }

  const { email } = parsed.data;
  const limited = await enforceRateLimits([
    { rule: FORGOT_IP_RULE, identity: clientIp(request) },
    { rule: FORGOT_EMAIL_RULE, identity: email },
  ]);
  if (limited) {
    authLog.warn("Password reset rate limited.", { email, reason: "rate-limited" });
    return limited;
  }

  // 账号是否存在都返回同一响应：否则该端点就成了账号枚举器。不存在的
  // 邮箱也消耗一个限流计数，探测速率与正常请求相同。
  const user = await getUserByEmail(email);
  if (!user) {
    authLog.info("Password reset requested for unknown email.", { email });
    return jsonOk({ success: true });
  }

  const deliver = await preparePasswordResetEmail(user);
  if (!deliver) {
    // 上面已挡过 SMTP 未配置；走到这里说明令牌签发期间配置被移除。
    authLog.warn("Password reset rejected: SMTP is not configured.", { userId: user.id, reason: "smtp-missing" });
    return jsonError("Email delivery is not configured on this server. Contact the administrator.", 503);
  }
  if (!(await deliver())) {
    authLog.warn("Password reset email delivery failed.", { userId: user.id, reason: "delivery-failed" });
    return jsonError("Unable to send the reset email. Please try again later.", 503);
  }
  return jsonOk({ success: true });
}
