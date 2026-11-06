import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { normalizeApiFormat, upstreamHeaders } from "@/lib/ai-formats";
import { assertOutboundUrl } from "@/lib/outbound-url";
import { parseProviderModels } from "@/lib/provider-models";
import { providerProbeSchema } from "@/lib/validation";
import { enforceRateLimits } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Discovery only: uses the caller's draft credentials, never saves a Provider. */
export async function POST(request: Request) {
  const session = await requireUserSession();
  if (!session) return jsonError("Unauthorized.", 401);
  const parsed = providerProbeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid provider discovery payload.", 400);
  const limited = await enforceRateLimits([{ rule: { bucket: "provider-probe", limit: 30, windowMs: 60_000 }, identity: session.sub }]);
  if (limited) return limited;
  const { baseUrl, apiKey, apiFormat } = parsed.data;
  let url: URL;
  try {
    url = await assertOutboundUrl(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
    url.hash = "";
  } catch {
    return jsonError("The provider URL must be a valid HTTP(S) URL.", 400);
  }
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
    const allModels = new Map<string, ReturnType<typeof parseProviderModels>[number]>();
    const cursors = new Set<string>();
    let bytes = 0;
    for (let page = 0; page < 50; page++) {
      const response = await fetch(url.toString(), {
        headers: upstreamHeaders(normalizeApiFormat(apiFormat, "chat"), apiKey),
        signal,
        redirect: "error", cache: "no-store",
      });
      if (!response.ok) {
        await response.body?.cancel();
        return jsonError(`Provider returned HTTP ${response.status}. Check its URL and API key.`, 502);
      }
      const reader = response.body?.getReader();
      if (!reader) return jsonError("The provider returned an empty response.", 502);
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 8 * 1024 * 1024) {
            await reader.cancel();
            return jsonError("The provider model list exceeds 8 MiB.", 502);
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      for (const model of parseProviderModels(payload)) {
        if (!allModels.has(model.modelId)) allModels.set(model.modelId, model);
      }
      if (allModels.size > 5_000) return jsonError("The provider returned too many models (maximum 5000).", 502);
      // Follow only recognized cursors at the same configured endpoint, never an upstream URL.
      const cursor = typeof payload.nextPageToken === "string" && payload.nextPageToken
        ? ["pageToken", payload.nextPageToken] : payload.has_more === true && typeof payload.last_id === "string" && payload.last_id
          ? ["after_id", payload.last_id] : null;
      if (payload.has_more === true && !cursor) return jsonError("The provider omitted its next model-list cursor.", 502);
      if (!cursor) return jsonOk({ models: [...allModels.values()] }, 200, { "Cache-Control": "private, no-store" });
      const key = cursor.join(":");
      if (cursors.has(key)) return jsonError("The provider returned a repeated model-list cursor.", 502);
      cursors.add(key);
      url.searchParams.set(cursor[0], cursor[1]);
    }
    return jsonError("The provider model list exceeded 50 pages.", 502);
  } catch {
    return jsonError("Unable to fetch provider models. Check the URL, API key and response format.", 502);
  }
}
