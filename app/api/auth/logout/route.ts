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

import { endCurrentSession } from "@/lib/auth";
import { jsonOk } from "@/lib/http";

/**
 * 注销当前会话。服务端记录转成墓碑（旧 Cookie 立即失效），Cookie 同时清除；
 * 未登录时同样返回成功。
 */
export async function POST() {
  await endCurrentSession();
  return jsonOk({ success: true });
}
