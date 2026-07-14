import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { env } from "@/lib/env";
import type { SessionClaims } from "@/lib/types";

const USER_COOKIE = "messenger_session";
const ADMIN_COOKIE = "messenger_admin_session";

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

export async function createUserSessionToken(userId: string, email: string) {
  return signSession({ sub: userId, email, role: "user" }, "30d");
}

export async function createAdminSessionToken() {
  return signSession({ sub: "admin", role: "admin" }, "12h");
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

export async function setAdminSessionCookie(token: string) {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export async function clearAdminSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(ADMIN_COOKIE);
}

export async function requireUserSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(USER_COOKIE)?.value;
  if (!token) {
    return null;
  }
  try {
    const claims = await verifySessionToken(token);
    return claims.role === "user" ? claims : null;
  } catch {
    return null;
  }
}

export async function requireAdminSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE)?.value;
  if (!token) {
    return null;
  }
  try {
    const claims = await verifySessionToken(token);
    return claims.role === "admin" ? claims : null;
  } catch {
    return null;
  }
}
