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

// Node-only console capture implementation. Statically imports `node:crypto`/
// `mongodb` via `lib/runtime-logs`, which Next's Edge Runtime cannot load.
// Loaded only through `instrumentation.ts`'s runtime-guarded dynamic import,
// so the Edge bundle never evaluates this module's top-level imports.
import { bindRawConsole, recordRuntimeLog } from "@/lib/runtime-logs";

let capturing = false;

/**
 * 包装 `console.error`/`warn`/`log`：先写回原始终端句柄（保留 `next start`
 * 的 stderr/stdout 可见性），再镜像一条 `runtime_logs` 文档。`capturing`
 * 防重入：本次写库期间触发的任何间接 console 调用直接跳过捕获。
 */
/**
 * 判定一条 console 调用是否属于 Next/Turbopack 框架自身的构建/HMR 噪声：
 * 这些 `⚠ ./lib/...Warning: A Node.js module is loaded...Edge Runtime` 与
 * `Compiled`/`Fast Refresh`/`webpack` 等 stderr 行不是业务事件，入库只会
 * 把日志页淹没在重复的编译告警里。识别后跳过采集，只保留业务运行时事件。
 */
function isFrameworkBuildNoise(message: string): boolean {
  // Turbopack 编译器对 Edge Runtime 静态分析时打的告警，dev 下每次 HMR 复发。
  if (message.includes("node module in edge runtime") || message.includes("not supported in the Edge Runtime")) {
    return true;
  }
  // 源码定位前缀（`⚠ ./path:line:col\n`）+ Turbopack/webpack 编译摘要。
  if (/^\u26a0 \.\//.test(message) || message.startsWith("Compiled") || message.startsWith("Fast Refresh")) {
    return true;
  }
  return false;
}

function capture(level: "error" | "warn" | "info", original: (...args: unknown[]) => void) {
  return (...args: unknown[]): void => {
    original(...args);
    if (capturing) {
      return;
    }
    capturing = true;
    try {
      const message = args.map(formatArg).filter(Boolean).join(" ") || level;
      if (isFrameworkBuildNoise(message)) {
        return;
      }
      void recordRuntimeLog({ level, source: "api", message, details: args });
    } finally {
      capturing = false;
    }
  };
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}`;
  }
  if (typeof arg === "string") {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * 安装 stderr/stdout → runtime_logs 捕获。仅 Node 运行时调用一次。
 * `bindRawConsole` 回填未被包装的原始 `console.error`，供 `recordRuntimeLog`
 * 失败兜底使用，绕开包装器避免递归。
 */
export function installConsoleCapture(): void {
  const rawError = console.error.bind(console);
  const rawWarn = console.warn.bind(console);
  const rawLog = console.log.bind(console);
  bindRawConsole(rawError);

  console.error = capture("error", rawError) as typeof console.error;
  console.warn = capture("warn", rawWarn) as typeof console.warn;
  console.log = capture("info", rawLog) as typeof console.log;
}

/**
 * 框架级未捕获错误兜底（Node 端实现）。由 `instrumentation.ts` 的
 * `onRequestError` 在确认 Node 运行时后动态委托到此。携带请求上下文
 * （method/path）与路由元信息（routePath/routeType）写入 `runtime_logs`。
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
