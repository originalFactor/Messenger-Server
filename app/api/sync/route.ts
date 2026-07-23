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
import { appUrl } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import {
  getDeltaSince,
  getDeltaSincePaged,
  SYNC_DEFAULT_LIMIT,
  SYNC_MAX_LIMIT,
  type SyncCollection,
} from "@/lib/storage";

export const runtime = "nodejs";

const ALLOWED_COLLECTIONS: ReadonlySet<SyncCollection> = new Set([
  "agents",
  "conversations",
  "providers",
]);

function rewriteAgentAvatars(agents: { _id: string; avatarUrl?: string | null }[]) {
  return agents.map((agent) => ({
    ...agent,
    avatarUrl: agent.avatarUrl ? appUrl(`/api/avatars/agents/${agent._id}`) : null,
  }));
}

export async function GET(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const { searchParams } = new URL(request.url);
  const sinceValue = searchParams.get("since");
  const since = sinceValue === null ? 0 : Number(sinceValue);
  if (!Number.isSafeInteger(since) || since < 0) {
    return jsonError("The since parameter must be a non-negative integer.", 400);
  }

  const collectionParam = searchParams.get("collection");
  const cursor = searchParams.get("cursor");
  const limitParam = searchParams.get("limit");

  // 旧路径：不传 collection 时一次性返回三集合合并响应（向后兼容现有 mobile 客户端）。
  if (!collectionParam) {
    try {
      const delta = await getDeltaSince(session.sub, since);
      return jsonOk({
        ...delta,
        agents: rewriteAgentAvatars(delta.agents),
      }, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      return storageErrorResponse(error, "Unable to load synchronization data.");
    }
  }

  if (!ALLOWED_COLLECTIONS.has(collectionParam as SyncCollection)) {
    return jsonError("collection must be one of: agents, conversations, providers.", 400);
  }
  if (cursor !== null && cursor !== undefined && cursor === "") {
    return jsonError("cursor must not be empty.", 400);
  }

  let limit = SYNC_DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      return jsonError("limit must be a positive integer.", 400);
    }
    limit = Math.min(parsed, SYNC_MAX_LIMIT);
  }

  try {
    const page = await getDeltaSincePaged(
      session.sub,
      since,
      collectionParam as SyncCollection,
      cursor,
      limit,
    );
    const documents = page.collection === "agents"
      ? rewriteAgentAvatars(page.documents as { _id: string; avatarUrl?: string | null }[])
      : page.documents;
    return jsonOk({
      collection: page.collection,
      documents,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      latestVersion: page.latestVersion,
    }, 200, { "Cache-Control": "no-store" });
  } catch (error) {
    return storageErrorResponse(error, "Unable to load synchronization data.");
  }
}
