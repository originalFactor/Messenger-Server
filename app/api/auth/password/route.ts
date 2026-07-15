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
  if (!verifyPassword(parsed.data.currentPassword, user.passwordHash)) {
    return jsonError("The current password is incorrect.", 401);
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return jsonError("The new password must be different.", 400);
  }

  await updateUserPassword(session.sub, hashPassword(parsed.data.newPassword));
  return jsonOk({ success: true });
}
