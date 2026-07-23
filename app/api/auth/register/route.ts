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

import { randomUUID } from "node:crypto";
import { createUserSessionToken, setUserSessionCookie } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { hashPassword } from "@/lib/security";
import { getUserByEmail, isDuplicateKeyError, saveUser } from "@/lib/storage";
import { credentialsSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = credentialsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid registration payload.", 400);
  }

  const { email, password } = parsed.data;
  const existing = await getUserByEmail(email);
  if (existing) {
    return jsonError("An account with this email already exists.", 409);
  }

  const now = Date.now();
  const user = {
    id: randomUUID(),
    email,
    passwordHash: await hashPassword(password),
    avatarUrl: null,
    avatarVersion: null,
    syncVersion: 0,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
  };

  let syncVersion: number;
  try {
    syncVersion = await saveUser(user);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return jsonError("An account with this email already exists.", 409);
    }
    throw error;
  }
  const token = await createUserSessionToken(user.id, user.email);
  await setUserSessionCookie(token);

  return jsonOk({
    user: {
      id: user.id,
      email: user.email,
      avatarUrl: null,
      avatarVersion: null,
      syncVersion,
      createdAt: user.createdAt,
    },
  }, 201);
}
