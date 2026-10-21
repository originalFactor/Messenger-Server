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

import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { env } from "@/lib/env";
import { createLogger } from "@/lib/runtime-logs";
import { deleteSession, getActiveSession, SESSION_TTL_MS } from "@/lib/sessions";
import { getUserById } from "@/lib/storage";
import type { SessionClaims, UserRole } from "@/lib/types";

const USER_COOKIE = "messenger_session";

/** 认证域日志器；仅记录低频、可审计的失败（避免匿名请求刷屏）。 */
const authLog = createLogger("auth");

function secretKey() {
  return new TextEncoder().encode(env.jwtSecret());
}

/** 绝对过期时刻（epoch 秒）：`SESSION_TTL_MS` 是唯一的有效期来源。 */
function sessionExpirySeconds() {
  return Math.floor((Date.now() + SESSION_TTL_MS) / 1000);
}

/**
 * 签发会话 token。`sid` 必须指向一条已写入 `user_sessions` 的活跃记录：
 * JWT 只承载凭证，有效性以库为准，所以这里的 `sid` 是必需的。
 */
export async function createUserSessionToken(
  userId: string,
  email: string,
  role: UserRole,
  sid: string,
) {
  return new SignJWT({ sub: userId, email, role, sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(sessionExpirySeconds())
    .sign(secretKey());
}

export async function verifySessionToken(token: string) {
  const result = await jwtVerify(token, secretKey());
  return result.payload as unknown as SessionClaims;
}

export async function setUserSessionCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(USER_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // 与库记录、JWT 的 exp 用同一个 30 天常量（lib/sessions.ts），三者必须同步到期。
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function clearUserSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(USER_COOKIE);
}

/**
 * 注销当前会话：按 token 里的 `sid` 删除会话记录，再清 Cookie。会话不留
 * 墓碑，行不存在即无效；删除必须先于清 Cookie，否则复制走的旧 Cookie 还能用。
 */
export async function endCurrentSession(): Promise<void> {
  const token = (await cookies()).get(USER_COOKIE)?.value;
  if (token) {
    try {
      const claims = await verifySessionToken(token);
      if (claims.sid) {
        await deleteSession(claims.sid);
      }
    } catch (error) {
      // token 无效（没有可注销的记录），或库暂时不可用：注销接口必须幂等
      // 成功，否则用户连「退出登录」都点不动。Cookie 照样清掉。
      authLog.warn("Unable to revoke the current session record.", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await clearUserSessionCookie();
}

/**
 * 管理员与普通用户共用同一个会话 Cookie，role 记录在 JWT claims 中。
 * 任何持有有效会话的用户（含管理员）都通过本函数；管理员专属操作必须
 * 再走 requireAdminUser()，它以数据库中的 role 为准，避免旧 token 提权。
 *
 * 签名有效只是第一步：claims 必须带 `sid`，且 `user_sessions` 里对应的
 * 记录仍然存在且未过期。因此注销、改密、30 天超时都能即时生效——纯 JWT
 * 做不到即时失效。改造前签发的无 `sid` token 一律视为过期。
 */
export async function requireUserSession(): Promise<SessionClaims | null> {
  const token = (await cookies()).get(USER_COOKIE)?.value;
  if (!token) {
    return null;
  }
  let claims: SessionClaims;
  try {
    claims = await verifySessionToken(token);
  } catch {
    return null;
  }
  if (claims.role !== "user" && claims.role !== "admin") {
    return null;
  }
  if (!claims.sid) {
    // 引入服务端会话之前签发的 token：没有对应的库记录，只能当作过期。
    authLog.info("Session token without sid rejected.", { userId: claims.sub, reason: "legacy-token" });
    return null;
  }
  const session = await getActiveSession(claims.sid, claims.sub);
  if (!session) {
    return null;
  }
  return claims;
}

export interface AdminSessionContext {
  claims: SessionClaims;
  role: UserRole;
}

export async function requireAdminUser(): Promise<AdminSessionContext | null> {
  const claims = await requireUserSession();
  if (!claims) {
    return null;
  }
  const user = await getUserById(claims.sub);
  if (!user || user.role !== "admin") {
    authLog.warn("Admin access denied.", { userId: claims.sub, email: claims.email, reason: user ? "not-admin" : "user-missing" });
    return null;
  }
  return { claims, role: user.role };
}
