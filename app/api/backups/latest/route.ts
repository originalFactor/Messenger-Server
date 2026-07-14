import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { sha256Hex } from "@/lib/security";
import { getLatestBackupPayload, saveLatestBackup } from "@/lib/storage";
import { backupPayloadSchema } from "@/lib/validation";

export async function GET() {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const backup = await getLatestBackupPayload(session.sub);
  if (!backup) {
    return jsonError("No backup uploaded yet.", 404);
  }
  const { manifest, payload } = backup;
  const { blobUrl: _blobUrl, ...safeManifest } = manifest;
  return jsonOk({ manifest: safeManifest, payload });
}

export async function PUT(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const body = await request.json().catch(() => null);
  const parsed = backupPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(`Invalid backup payload: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`).join("; ")}`, 400);
  }

  const payloadJson = JSON.stringify(parsed.data);
  const manifest = await saveLatestBackup(session.sub, parsed.data, payloadJson, sha256Hex(payloadJson));
  const { blobUrl: _blobUrl, ...safeManifest } = manifest;
  return jsonOk({ manifest: safeManifest });
}
