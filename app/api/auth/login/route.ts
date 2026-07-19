import { createUserSessionToken, setUserSessionCookie } from "@/lib/auth";
import { appUrl } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { verifyPassword } from "@/lib/security";
import { getUserByEmail, updateUserLastLogin } from "@/lib/storage";
import { credentialsSchema } from "@/lib/validation";

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
