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

// Loaded only by instrumentation.ts in the Node runtime.
import { recordRuntimeLog } from "@/lib/runtime-logs";

export { installOutputCapture } from "@/lib/runtime-logs";

/**
 * 框架级未捕获错误兜底（Node 端实现）。由 `instrumentation.ts` 的
 * `onRequestError` 在确认 Node 运行时后动态委托到此。携带请求上下文
 * （method/path）与路由元信息（routePath/routeType）写入日志文件。
 */
export async function recordRequestError(
  error: unknown,
  request: { method: string; path: string },
  context: {
    routerKind: string;
    routePath: string;
    routeType: string;
  },
): Promise<void> {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  // React 处理过的错误会挂 `digest`；`in` 缩窄后 TS 已把属性推断为 unknown，
  // 无需 unchecked cast 即可安全读，String() 收敛为字符串。
  let digest: string | undefined;
  if (typeof error === "object" && error !== null && "digest" in error) {
    digest = String(error.digest);
  }
  await recordRuntimeLog({
    level: "error",
    source: "api",
    method: request.method,
    path: request.path,
    status: 500,
    message: digest ? `${message} (digest: ${digest})` : message,
    details: {
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      routePath: context.routePath,
      routeType: context.routeType,
      routerKind: context.routerKind,
    },
  });
}
