import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { sha256Hex } from "@/lib/security";
import { getBackupManifest, saveLatestBackup } from "@/lib/storage";
import { backupPayloadSchema } from "@/lib/validation";

export async function GET() {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const manifest = await getBackupManifest(session.sub);
  if (!manifest) {
    return jsonError("No backup uploaded yet.", 404);
  }

  const response = await fetch(manifest.blobUrl, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    return jsonError("Backup payload is unavailable.", 502);
  }

  const payload = await response.json();
  return jsonOk({ manifest, payload });
}

export async function PUT(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const body = await request.json().catch(() => null);
  const parsed = backupPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError("Invalid backup payload.", 400);
  }

  const payloadJson = JSON.stringify(parsed.data);
  const manifest = await saveLatestBackup(session.sub, parsed.data, payloadJson, sha256Hex(payloadJson));
  return jsonOk({ manifest });
}
