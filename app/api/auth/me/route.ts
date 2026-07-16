import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { getUserById } from "@/lib/storage";

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
      avatarUrl: user.avatarUrl ? new URL("/api/avatars/user", request.url).toString() : null,
      avatarVersion: user.avatarVersion ?? null,
      syncVersion: user.syncVersion,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
    },
  });
}
