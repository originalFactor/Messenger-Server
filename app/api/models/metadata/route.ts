import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { getCatalogRates } from "@/lib/pi-catalog";
import { matchModelDefault } from "@/lib/model-rates";
import { modelMetadataQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";

/** Read-only capabilities for any signed-in Messenger user; no upstream credentials. */
export async function GET(request: Request) {
  if (!await requireUserSession()) return jsonError("Unauthorized.", 401);
  const parsed = modelMetadataQuerySchema.safeParse(new URL(request.url).searchParams.get("modelId"));
  if (!parsed.success) return jsonError("A valid modelId is required.", 400);
  const { models, degraded } = await getCatalogRates();
  const metadata = matchModelDefault(parsed.data, models) ?? null;
  return jsonOk({ metadata, degraded }, 200, { "Cache-Control": "private, no-store" });
}
