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

import { createAdminSessionToken, setAdminSessionCookie } from "@/lib/auth";
import { env } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { password?: string } | null;
  if (!body?.password) {
    return jsonError("Password is required.", 400);
  }

  if (body.password !== env.adminPassword()) {
    return jsonError("Invalid admin password.", 401);
  }

  const token = await createAdminSessionToken();
  await setAdminSessionCookie(token);
  return jsonOk({ success: true });
}
