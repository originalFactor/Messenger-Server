import { randomUUID } from "node:crypto";
import { createUserSessionToken, setUserSessionCookie } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { hashPassword } from "@/lib/security";
import { getUserByEmail, saveUser } from "@/lib/storage";
import { credentialsSchema } from "@/lib/validation";

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
    passwordHash: hashPassword(password),
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
  };

  await saveUser(user);
  const token = await createUserSessionToken(user.id, user.email);
  await setUserSessionCookie(token);

  return jsonOk({ user: { id: user.id, email: user.email, createdAt: user.createdAt } }, 201);
}
