/*
 * Copyright 2026 originalFactor
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { requireUserSession } from "@/lib/auth";
import { relayCompletion } from "@/lib/ai-relay";
import { jsonError } from "@/lib/http";
import { getUserById } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Browser chat endpoint. The browser only receives the session cookie; the
 * internal AI key never has to be copied into local storage or JavaScript.
 */
export async function POST(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const user = await getUserById(session.sub);
  if (!user) {
    return jsonError("User not found.", 404);
  }
  if (!user.aiApiKey) {
    return jsonError("Your built-in AI service is not configured yet.", 409);
  }

  const body = await request.text().catch(() => "");
  if (!body) {
    return jsonError("Request body is required.", 400);
  }

  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${user.aiApiKey}`);
  headers.set("content-type", "application/json");

  return relayCompletion({
    format: "chat",
    request: new Request(request.url, {
      method: "POST",
      headers,
      body,
      signal: request.signal,
    }),
  });
}
