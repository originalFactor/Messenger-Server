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

import { createUserSessionToken, setUserSessionCookie } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { verifyPassword } from "@/lib/security";
import { getUserByEmail, updateUserLastLogin } from "@/lib/storage";
import { credentialsSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = credentialsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid login payload.", 400);
  }

  const { email, password } = parsed.data;
  const user = await getUserByEmail(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return jsonError("Invalid email or password.", 401);
  }

  const now = Date.now();
  await updateUserLastLogin(user.id, now);
  const token = await createUserSessionToken(user.id, user.email);
  await setUserSessionCookie(token);

  return jsonOk({
    user: {
      id: user.id,
      email: user.email,
      avatarUrl: user.avatarUrl ? appUrl("/api/avatars/user") : null,
      avatarVersion: user.avatarVersion ?? null,
      syncVersion: user.syncVersion,
      lastLoginAt: now,
    },
  });
}
