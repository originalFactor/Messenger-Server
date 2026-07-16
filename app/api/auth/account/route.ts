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
  if (!verifyPassword(parsed.data.currentPassword, user.passwordHash)) {
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
