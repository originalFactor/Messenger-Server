import { requireUserSession } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { getUserById } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const user = await getUserById(session.sub);
  if (!user) {
    return jsonError("User not found.", 404);
  }

  return jsonOk({
    user: {
      id: user.id,
      email: user.email,
      avatarUrl: user.avatarUrl ? appUrl("/api/avatars/user") : null,
      avatarVersion: user.avatarVersion ?? null,
      syncVersion: user.syncVersion,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
    },
  });
}
