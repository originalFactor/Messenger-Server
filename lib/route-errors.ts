/*
 * Copyright 2026 ECSDevs
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { jsonError } from "@/lib/http";
import { AvatarLockError } from "@/lib/avatar-locks";
import { ConflictError, isDuplicateKeyError, NotFoundError } from "@/lib/storage";

function errorDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    };
  }

  return { value: error };
}

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
  console.error(`[API] ${fallbackMessage}`, errorDetails(error));
  return jsonError(fallbackMessage, 500);
}
