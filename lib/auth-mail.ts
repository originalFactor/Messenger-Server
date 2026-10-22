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

import { issueAuthToken, RESET_TOKEN_TTL_MS, VERIFICATION_TOKEN_TTL_MS } from "@/lib/auth-tokens";
import { mailEnabled, sendPasswordResetEmail, sendVerificationEmail } from "@/lib/mail";
import { createLogger } from "@/lib/runtime-logs";
import type { StoredUser } from "@/lib/types";

/**
 * 「签发令牌 + 投递邮件」的两段式组合，注册（后台投递）、重发验证、
 * 找回密码（前台等待结果）三处共用。
 *
 * 签发是同步的（一次 Mongo 写），投递是返回的函数：调用方决定是 `await`
 * 它把投递结果告诉用户，还是交给 `after()` 在响应之后再做。SMTP 未配置时
 * 返回 `null`——此时连令牌都不该生成，否则会留下永远收不到的死链接。
 *
 * 投递函数返回 `true` = SMTP 已接受，`false` = 投递失败（已记日志）。
 */

const authLog = createLogger("auth");

export async function prepareVerificationEmail(user: StoredUser): Promise<(() => Promise<boolean>) | null> {
  if (!mailEnabled()) {
    authLog.warn("Verification email skipped: SMTP is not configured.", { userId: user.id, reason: "smtp-missing" });
    return null;
  }
  const { token } = await issueAuthToken(user.id, user.email, "verify_email");
  const expiresInHours = Math.round(VERIFICATION_TOKEN_TTL_MS / (60 * 60 * 1000));
  return async () => {
    const sent = await sendVerificationEmail(user.email, token, expiresInHours);
    authLog.info("Verification email issued.", { userId: user.id, sent });
    return sent;
  };
}

export async function preparePasswordResetEmail(user: StoredUser): Promise<(() => Promise<boolean>) | null> {
  if (!mailEnabled()) {
    authLog.warn("Password reset email skipped: SMTP is not configured.", { userId: user.id, reason: "smtp-missing" });
    return null;
  }
  const { token } = await issueAuthToken(user.id, user.email, "reset_password");
  const expiresInMinutes = Math.round(RESET_TOKEN_TTL_MS / (60 * 1000));
  return async () => {
    const sent = await sendPasswordResetEmail(user.email, token, expiresInMinutes);
    authLog.info("Password reset email issued.", { userId: user.id, sent });
    return sent;
  };
}
