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

import { createUserSessionToken, setUserSessionCookie } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { clientIp, enforceRateLimits } from "@/lib/rate-limit";
import { createUserSession, purgeExpiredSessions, purgeSettledTombstones } from "@/lib/sessions";
import { createLogger } from "@/lib/runtime-logs";
import { verifyPassword } from "@/lib/security";
import { getUserByEmail, updateUserLastLogin } from "@/lib/storage";
import { buildSelfUserView } from "@/lib/user-view";
import { credentialsSchema } from "@/lib/validation";

export const runtime = "nodejs";

const authLog = createLogger("auth");

/** 同一 IP 每小时最多 20 次登录尝试；同一邮箱每小时最多 10 次（防定向爆破）。 */
const LOGIN_IP_RULE = { bucket: "login-ip", limit: 20, windowMs: 60 * 60 * 1000 };
const LOGIN_EMAIL_RULE = { bucket: "login-email", limit: 10, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request) {
  const parsed = credentialsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid login payload.", 400);
  }

  const { email, password } = parsed.data;
  const limited = await enforceRateLimits([
    { rule: LOGIN_IP_RULE, identity: clientIp(request) },
    { rule: LOGIN_EMAIL_RULE, identity: email },
  ]);
  if (limited) {
    authLog.warn("Login rate limited.", { email, reason: "rate-limited" });
    return limited;
  }

  const user = await getUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    authLog.warn("Login failed.", { email, reason: "invalid-credentials" });
    return jsonError("Invalid email or password.", 401);
  }

  const now = Date.now();
  await updateUserLastLogin(user.id, now);
  // 登录是低频事件：顺手清掉已过期的会话（TTL 线程可能滞后），再按剩下的
  // 会话重算一次实体墓碑——让「阻塞清理的那条会话已经过期」立刻生效。
  // 这两步都在新会话写入之前做：新会话的游标还是未知的，不该参与判定。
  // 失败不影响登录。
  const purged = await purgeExpiredSessions().catch(() => 0);
  await purgeSettledTombstones(user.id).catch(() => 0);
  const sid = await createUserSession(user.id, {
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  });
  const token = await createUserSessionToken(user.id, user.email, user.role, sid);
  await setUserSessionCookie(token);
  authLog.info("Login succeeded.", { userId: user.id, email: user.email, role: user.role, sid, purgedSessions: purged });

  return jsonOk({ user: await buildSelfUserView(user, now) });
}
