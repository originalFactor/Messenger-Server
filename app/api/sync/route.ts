import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import { getDeltaSince } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const sinceValue = new URL(request.url).searchParams.get("since");
  const since = sinceValue === null ? 0 : Number(sinceValue);
  if (!Number.isSafeInteger(since) || since < 0) {
    return jsonError("The since parameter must be a non-negative integer.", 400);
  }

  try {
    const delta = await getDeltaSince(session.sub, since);
    return jsonOk(delta, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    return storageErrorResponse(error, "Unable to load synchronization data.");
  }
}
