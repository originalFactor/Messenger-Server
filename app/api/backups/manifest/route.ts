import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { getBackupManifest } from "@/lib/storage";

export async function GET() {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const manifest = await getBackupManifest(session.sub);
  return jsonOk({ manifest });
}
