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
