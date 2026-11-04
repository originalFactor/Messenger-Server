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

/** Install stdout/stderr file capture before the Node server accepts requests. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { installOutputCapture } = await import("./instrumentation-node");
  installOutputCapture();
}

/**
 * 框架级未捕获错误兜底。Next 在 Server Component 渲染、Server Action、
 * Route Handler 及 Proxy 中捕获到未经业务 try/catch 的异常时回调。
 * 与 console 捕获互补：这里拿到框架认为值得上报的错误，且具备完整请求坐标。
 *
 * Edge 线程同样回调此函数，但 Edge 不能访问本地日志文件；靠 `NEXT_RUNTIME`
 * 判定后委托 Node 端实现。Edge 线程的安全兜底：错误落到终端 stderr
 * （由框架默认行为处理），不写文件。
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    // Edge 线程无本地文件访问；退回默认 stderr，避免加载 Node-only 模块。
    console.error("[onRequestError:edge]", error, { request, context });
    return;
  }
  const { recordRequestError } = await import("./instrumentation-node");
  await recordRequestError(error, request, context);
};
