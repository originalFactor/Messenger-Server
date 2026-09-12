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

import { requireAdminUser } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { storageErrorResponse } from "@/lib/route-errors";
import { issueCards, listCards } from "@/lib/storage";
import { cardIssueSchema } from "@/lib/validation";
import type { CardKeyStatus } from "@/lib/types";

export const runtime = "nodejs";

const cardStatuses: CardKeyStatus[] = ["unused", "redeemed", "disabled"];

export async function GET(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const status = cardStatuses.find((value) => value === statusParam);
  if (statusParam && !status) {
    return jsonError("Invalid card status filter.", 400);
  }

  const page = await listCards({
    status,
    planId: url.searchParams.get("planId") ?? undefined,
    cursor: url.searchParams.get("cursor"),
    limit: Number(url.searchParams.get("limit")) || undefined,
  });
  return jsonOk(page);
}

export async function POST(request: Request) {
  const admin = await requireAdminUser();
  if (!admin) {
    return jsonError("Forbidden.", 403);
  }

  const parsed = cardIssueSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Invalid card issue payload.", 400);
  }

  try {
    const cards = await issueCards({
      planId: parsed.data.planId,
      count: parsed.data.count,
      note: parsed.data.note ?? null,
      createdByUserId: admin.claims.sub,
    });
    return jsonOk({ cards }, 201);
  } catch (error) {
    return storageErrorResponse(error, "Unable to issue card keys.");
  }
}
