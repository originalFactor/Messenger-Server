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

import { requireUserSession } from "@/lib/auth";
import { jsonError } from "@/lib/http";
import { getRemoteHub, type RemoteConnection, type RemoteEventName } from "@/lib/remote-hub";
import { getActiveSession } from "@/lib/sessions";
import { deviceIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 反向代理（nginx 默认 60s）会掐掉静默的连接，注释帧只是为了保活。 */
const HEARTBEAT_MS = 15_000;
/** 每 N 次心跳复核一次会话：注销/改密码后长连接必须随之断开，不能活到自然断线。 */
const SESSION_RECHECK_EVERY = 4;
/** 积压超过这个帧数说明对端不读了，直接断开而不是无限占内存。 */
const MAX_QUEUED_FRAMES = 1_000;

/**
 * 设备的中转长连接。连接存在即在线；断开即离线。连接建立时立刻收到一帧
 * `presence`，之后集合每变化一次再收到一帧。
 */
export async function GET(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }
  const device = deviceIdSchema.safeParse(new URL(request.url).searchParams.get("deviceId"));
  if (!device.success) {
    return jsonError("A valid deviceId query parameter is required.", 400);
  }

  const hub = getRemoteHub();
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const write = (frame: string): boolean => {
    if (closed || (controller.desiredSize ?? 0) < -MAX_QUEUED_FRAMES) {
      return false;
    }
    try {
      controller.enqueue(encoder.encode(frame));
      return true;
    } catch {
      return false;
    }
  };

  const connection: RemoteConnection = {
    deviceId: device.data,
    send: (event: RemoteEventName, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(timer);
      hub.unregister(session.sub, connection);
      try {
        controller.close();
      } catch {
        // 流已被对端取消。
      }
    },
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      let beats = 0;
      timer = setInterval(() => {
        if (!write(": keep-alive\n\n")) {
          connection.close();
          return;
        }
        beats += 1;
        if (beats % SESSION_RECHECK_EVERY === 0 && session.sid) {
          void getActiveSession(session.sid, session.sub)
            .then((active) => {
              if (!active) {
                connection.close();
              }
            })
            .catch(() => undefined);
        }
      }, HEARTBEAT_MS);
      request.signal.addEventListener("abort", () => connection.close());
      hub.register(session.sub, connection);
    },
    cancel() {
      connection.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 关闭 nginx 对该响应的缓冲，否则帧会攒着不发。
      "X-Accel-Buffering": "no",
    },
  });
}
