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

import { getRemoteHub } from "@/lib/remote-hub";
import { relayPost } from "@/lib/remote-relay";
import { remoteToolCallSchema } from "@/lib/validation";

export const runtime = "nodejs";

/** 发起端把工作区工具调用转发给项目所属设备。发送方必须是该账号当前在线的设备。 */
export async function POST(request: Request) {
  return relayPost(request, remoteToolCallSchema, "toolCall", (userId, call) =>
    getRemoteHub().isOnline(userId, call.fromDeviceId) ? null : "The sending device is not connected to the relay.",
  );
}
