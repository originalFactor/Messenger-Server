import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { getCatalogRates } from "@/lib/pi-catalog";
import { listEnabledUpstreams } from "@/lib/storage";
import { resolveModelCapabilities, resolveUpstreamCapabilities } from "@/lib/model-capabilities";
import { matchModelDefault } from "@/lib/model-rates";
import { modelMetadataQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";

/** Read-only capabilities for any signed-in Messenger user; no upstream credentials. */
export async function GET(request: Request) {
  if (!await requireUserSession()) return jsonError("Unauthorized.", 401);
  const parsed = modelMetadataQuerySchema.safeParse(new URL(request.url).searchParams.get("modelId"));
  if (!parsed.success) return jsonError("A valid modelId is required.", 400);
  const query = new URL(request.url).searchParams;
  const isCloud = query.get("cloud") === "1";
  const target = query.get("catalogModelId");
  if (target !== null && !modelMetadataQuerySchema.safeParse(target).success) return jsonError("A valid catalogModelId is required.", 400);
  const [{ models, degraded }, upstreams] = await Promise.all([
    getCatalogRates(), isCloud ? listEnabledUpstreams() : Promise.resolve([]),
  ]);
  const cloudModel = isCloud ? resolveUpstreamCapabilities(upstreams, models).get(parsed.data) : undefined;
  const metadata = cloudModel ?? (!isCloud && target !== null
    ? Object.hasOwn(models, target) ? resolveModelCapabilities(parsed.data, models, { catalogModelId: target }) : null
    : matchModelDefault(parsed.data, models) ? resolveModelCapabilities(parsed.data, models) : null);
  return jsonOk({ metadata, degraded }, 200, { "Cache-Control": "private, no-store" });
}
