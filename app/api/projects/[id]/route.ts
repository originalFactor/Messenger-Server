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

import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import { softDeleteProject, upsertProject } from "@/lib/storage";
import { entityIdSchema, projectSchema } from "@/lib/validation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

async function getProjectId(context: RouteContext): Promise<string | null> {
  const { id } = await context.params;
  return entityIdSchema.safeParse(id).success ? id : null;
}

export async function PUT(request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const projectId = await getProjectId(context);
  if (!projectId) {
    return jsonError("Invalid project ID.", 400);
  }

  const parsed = projectSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const reason = parsed.error.issues[0];
    const detail = reason ? `${reason.path.join(".") || "(body)"}: ${reason.message}` : "payload could not be read";
    console.error("Invalid project payload for", projectId, "->", detail, parsed.error.flatten());
    return jsonError(`Invalid project payload (${detail}).`, 400);
  }
  if (parsed.data.id !== projectId) {
    return jsonError("The project ID must match the request path.", 400);
  }

  try {
    const version = await upsertProject(session.sub, parsed.data);
    return jsonOk({ id: projectId, version });
  } catch (error) {
    return storageErrorResponse(error, "Unable to save the project.");
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const projectId = await getProjectId(context);
  if (!projectId) {
    return jsonError("Invalid project ID.", 400);
  }

  try {
    const version = await softDeleteProject(session.sub, projectId);
    return jsonOk({ id: projectId, version });
  } catch (error) {
    return storageErrorResponse(error, "Unable to delete the project.");
  }
}