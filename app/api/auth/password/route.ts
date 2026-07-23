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

import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { hashPassword, verifyPassword } from "@/lib/security";
import { getUserById, updateUserPassword } from "@/lib/storage";
import { passwordChangeSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const parsed = passwordChangeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid password change payload.", 400);
  }

  const user = await getUserById(session.sub);
  if (!user) {
    return jsonError("User not found.", 404);
  }
  if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    return jsonError("The current password is incorrect.", 401);
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return jsonError("The new password must be different.", 400);
  }

  await updateUserPassword(session.sub, await hashPassword(parsed.data.newPassword));
  return jsonOk({ success: true });
}
