/*
 * Copyright 2026 ECSDevs
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
import { getUserById } from "@/lib/storage";
import type { SessionClaims, UserRole } from "@/lib/types";

const USER_COOKIE = "messenger_session";

function secretKey() {
  return new TextEncoder().encode(env.jwtSecret());
}

async function signSession(claims: SessionClaims, expiresIn: string) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey());
}

export async function createUserSessionToken(userId: string, email: string, role: UserRole) {
  return signSession({ sub: userId, email, role }, "30d");
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
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearUserSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(USER_COOKIE);
}

/**
 * 管理员与普通用户共用同一个会话 Cookie，role 记录在 JWT claims 中。
 * 任何持有有效会话的用户（含管理员）都通过本函数；管理员专属操作必须
 * 再走 requireAdminUser()，它以数据库中的 role 为准，避免旧 token 提权。
 */
export async function requireUserSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(USER_COOKIE)?.value;
  if (!token) {
    return null;
  }
  try {
    const claims = await verifySessionToken(token);
    return claims.role === "user" || claims.role === "admin" ? claims : null;
  } catch {
    return null;
  }
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
    return null;
  }
  return { claims, role: user.role };
}
