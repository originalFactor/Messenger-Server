import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { integrationCatalog } from "@/lib/integration-catalog";

export const runtime = "nodejs";

export async function GET() {
  if (!await requireUserSession()) return jsonError("Unauthorized.", 401);
  return jsonOk(integrationCatalog, 200, { "Cache-Control": "private, no-store" });
}
