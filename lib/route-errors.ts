import { jsonError } from "@/lib/http";
import { AvatarLockError } from "@/lib/avatar-locks";
import { ConflictError, isDuplicateKeyError, NotFoundError } from "@/lib/storage";

export function storageErrorResponse(error: unknown, fallbackMessage: string) {
  if (error instanceof NotFoundError) {
    return jsonError(error.message, 404);
  }
  if (error instanceof ConflictError) {
    return jsonError(error.message, 409);
  }
  if (error instanceof AvatarLockError) {
    return jsonError(error.message, 409);
  }
  if (isDuplicateKeyError(error)) {
    return jsonError("The requested change conflicts with existing data.", 409);
  }
  return jsonError(fallbackMessage, 500);
}
