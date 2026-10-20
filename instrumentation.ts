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

import type { Instrumentation } from "next";

/**
 * stderr/stdout → runtime_logs 捕获安装。仅 Node 运行时执行。
 *
 * Edge Runtime 不能加载 `node:crypto`/`mongodb`（`instrumentation-node.ts`
 * 的静态依赖），故不能静态 `import` 该模块——Next 会把 instrumentation 的
 * 顶层导入打到 Edge bundle 并抛 "node module in edge runtime"。改为运行时
 * 判定后动态导入，Edge 线程走 early return 不触发该加载。这是
 * "platform-specific module that does not exist everywhere" 的合法例外。
 *
 * 覆盖范围：所有散落的 `console.error`/`warn`/`log` 站点一律入库，无需逐处
 * 插桩；`onRequestError` 再补一层框架级未捕获异常（携带 method/path）。
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  void import("./instrumentation-node").then(({ installConsoleCapture }) => {
    installConsoleCapture();
  });
}

/**
 * 框架级未捕获错误兜底。Next 在 Server Component 渲染、Server Action、
 * Route Handler 及 Proxy 中捕获到未经业务 try/catch 的异常时回调。
 * 与 console 捕获互补：这里拿到框架认为值得上报的错误，且具备完整请求坐标。
 *
 * Edge 线程同样回调此函数，但 Edge 不能写 MongoDB；靠 `NEXT_RUNTIME`
 * 判定后委托 Node 端实现。Edge 线程的安全兜底：错误落到终端 stderr
 * （由框架默认行为处理），不写库。
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    // Edge 线程无 MongoDB 访问；退回默认 stderr，避免加载 Node-only 模块。
    console.error("[onRequestError:edge]", error, { request, context });
    return;
  }
  const { recordRequestError } = await import("./instrumentation-node");
  await recordRequestError(error, request, context);
};
