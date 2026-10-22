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

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { prepareVerificationEmail } from "@/lib/auth-mail";
import { createUserSessionToken, setUserSessionCookie } from "@/lib/auth";
import { generateAiApiKey } from "@/lib/apikeys";
import { jsonError, jsonOk } from "@/lib/http";
import { clientIp, enforceRateLimits } from "@/lib/rate-limit";
import { createUserSession } from "@/lib/sessions";
import { createLogger } from "@/lib/runtime-logs";
import { hashPassword } from "@/lib/security";
import { getUserByEmail, isDuplicateKeyError, saveUser } from "@/lib/storage";
import { buildSelfUserView } from "@/lib/user-view";
import { credentialsSchema } from "@/lib/validation";

export const runtime = "nodejs";

const authLog = createLogger("auth");

/** 同一 IP 每小时最多 10 次注册尝试（每次都会跑 scrypt）。 */
const REGISTER_RULE = { bucket: "register-ip", limit: 10, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request) {
  const parsed = credentialsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid registration payload.", 400);
  }

  const limited = await enforceRateLimits([{ rule: REGISTER_RULE, identity: clientIp(request) }]);
  if (limited) {
    authLog.warn("Registration rate limited.", { reason: "rate-limited" });
    return limited;
  }

  const { email, password } = parsed.data;
  const existing = await getUserByEmail(email);
  if (existing) {
    authLog.warn("Registration rejected: email exists.", { email });
    return jsonError("An account with this email already exists.", 409);
  }

  const now = Date.now();
  const user = {
    id: randomUUID(),
    email,
    passwordHash: await hashPassword(password),
    // role 由 saveUser 事务决定（首个注册用户晋升 admin），此处仅占位。
    role: "user" as const,
    aiApiKey: generateAiApiKey(),
    quotaBalance: 0,
    quotaExpiresAt: null,
    // 注册不直接算已验证：发给邮箱的链接点开后才置位（SMTP 未配置时
    // 该账号会一直保持未验证，控制台会提示管理员配置 SMTP）。
    emailVerifiedAt: null,
    avatarUrl: null,
    avatarVersion: null,
    syncVersion: 0,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
  };

  let syncVersion: number;
  let role: "user" | "admin";
  try {
    const saved = await saveUser(user);
    syncVersion = saved.syncVersion;
    role = saved.role;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      authLog.warn("Registration rejected: duplicate key.", { email, userId: user.id });
      return jsonError("An account with this email already exists.", 409);
    }
    throw error;
  }
  const sid = await createUserSession(user.id, {
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  });
  const token = await createUserSessionToken(user.id, user.email, role, sid);
  await setUserSessionCookie(token);
  authLog.info("Registration succeeded.", { userId: user.id, email: user.email, role, sid });

  // 注册响应不等 SMTP：令牌先落库，投递放到响应之后（`after`）。邮件发不
  // 出去也不影响注册结果——客户端可以调 `POST /api/auth/verify-email/resend`
  // 重发，账号已经可用。
  const deliver = await prepareVerificationEmail(user).catch((error: unknown) => {
    authLog.error("Unable to issue the verification token.", {
      userId: user.id,
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    });
    return null;
  });
  if (deliver) {
    after(async () => {
      await deliver().catch(() => false);
    });
  }

  return jsonOk({ user: await buildSelfUserView({ ...user, role, syncVersion }) }, 201);
}
