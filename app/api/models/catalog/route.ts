import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { getCatalogRates } from "@/lib/pi-catalog";
import { enforceRateLimits } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Public catalog data for authenticated BYOK editors, never platform upstream configuration. */
export async function GET(request: Request) {
  const session = await requireUserSession();
  if (!session) return jsonError("Unauthorized.", 401);
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (refresh) {
    const limited = await enforceRateLimits([{ rule: { bucket: "provider-catalog-refresh", limit: 5, windowMs: 60_000 }, identity: session.sub }]);
    if (limited) return limited;
  }
  const { rates, models, degraded } = await getCatalogRates(refresh);
  return jsonOk({ rates, models, degraded }, 200, { "Cache-Control": "private, no-store" });
}
