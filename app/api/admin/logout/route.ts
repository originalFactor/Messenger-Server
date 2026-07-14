import { clearAdminSessionCookie } from "@/lib/auth";
import { jsonOk } from "@/lib/http";

export async function POST() {
  await clearAdminSessionCookie();
  return jsonOk({ success: true });
}
