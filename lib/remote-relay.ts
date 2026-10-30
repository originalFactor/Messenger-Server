/*
 * Copyright 2026 originalFactor
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

import type { z } from "zod";
import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { getRemoteHub, type RemoteEventName } from "@/lib/remote-hub";

/** 单个中转请求体上限：工具输出最大 4M 字符，留出 JSON 转义余量。 */
const MAX_BODY_BYTES = 12_000_000;

/**
 * `POST /api/remote/tool-*` 的共用实现：校验会话与载荷，再把载荷原样转发给
 * `targetDeviceId` 的 SSE 连接。目标不在线是预期状态（设备关机、断网），回
 * 409 让核心把项目标成不可用，而不是当作服务端错误。
 */
export async function relayPost<S extends z.ZodType<{ targetDeviceId: string }>>(
  request: Request,
  schema: S,
  event: RemoteEventName,
  authorize?: (userId: string, payload: z.infer<S>) => string | null,
) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    return jsonError("Payload too large.", 413);
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const reason = parsed.error.issues[0];
    const detail = reason ? `${reason.path.join(".") || "(body)"}: ${reason.message}` : "payload could not be read";
    return jsonError(`Invalid relay payload (${detail}).`, 400);
  }
  const denied = authorize?.(session.sub, parsed.data);
  if (denied) {
    return jsonError(denied, 403);
  }
  const delivered = getRemoteHub().deliver(session.sub, parsed.data.targetDeviceId, event, parsed.data);
  if (!delivered) {
    return jsonError("The target device is offline.", 409);
  }
  return jsonOk({ delivered: true }, 202);
}
