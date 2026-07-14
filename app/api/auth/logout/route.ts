import { clearUserSessionCookie } from "@/lib/auth";
import { jsonOk } from "@/lib/http";

export async function POST() {
  await clearUserSessionCookie();
  return jsonOk({ success: true });
}
