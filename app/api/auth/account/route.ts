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

import { clearUserSessionCookie, requireUserSession } from "@/lib/auth";
import { deleteAgentAvatar, deleteMarketAgentAvatar, deleteUserAvatar } from "@/lib/avatars";
import { jsonError, jsonOk } from "@/lib/http";
import { getUserById, deleteUserAccount } from "@/lib/storage";
import { verifyPassword } from "@/lib/security";
import { passwordDeleteSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function DELETE(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const parsed = passwordDeleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Current password is required.", 400);
  }
  const user = await getUserById(session.sub);
  if (!user) {
    await clearUserSessionCookie();
    return jsonOk({ success: true });
  }
  if (!(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
    return jsonError("The current password is incorrect.", 401);
  }

  const { agentIds, marketAgentIds } = await deleteUserAccount(session.sub);
  const avatarCleanup = await Promise.allSettled([
    deleteUserAvatar(session.sub),
    ...agentIds.map((agentId) => deleteAgentAvatar(agentId)),
    ...marketAgentIds.map((agentId) => deleteMarketAgentAvatar(agentId)),
  ]);
  for (const result of avatarCleanup) {
    if (result.status === "rejected") {
      console.error("Unable to clean up account avatar blob after account deletion.", result.reason);
    }
  }
  await clearUserSessionCookie();
  return jsonOk({ success: true });
}
