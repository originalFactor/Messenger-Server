import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { getCatalogRates } from "@/lib/pi-catalog";
import { listUpstreamsForModel } from "@/lib/storage";
import { resolveModelCapabilities } from "@/lib/model-capabilities";
import { matchModelDefault } from "@/lib/model-rates";
import { modelMetadataQuerySchema } from "@/lib/validation";

export const runtime = "nodejs";

/** Read-only capabilities for any signed-in Messenger user; no upstream credentials. */
export async function GET(request: Request) {
  if (!await requireUserSession()) return jsonError("Unauthorized.", 401);
  const parsed = modelMetadataQuerySchema.safeParse(new URL(request.url).searchParams.get("modelId"));
  if (!parsed.success) return jsonError("A valid modelId is required.", 400);
  const { models, degraded } = await getCatalogRates();
  const isCloud = new URL(request.url).searchParams.get("cloud") === "1";
  const upstreams = isCloud ? await listUpstreamsForModel(parsed.data) : [];
  const metadata = upstreams.length || matchModelDefault(parsed.data, models)
    ? resolveModelCapabilities(parsed.data, models, upstreams[0]?.modelMeta?.[parsed.data]) : null;
  return jsonOk({ metadata, degraded }, 200, { "Cache-Control": "private, no-store" });
}
