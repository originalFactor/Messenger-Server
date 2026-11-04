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

/** 管理员配置的上游允许公网、内网及本机地址，仅校验 URL 和 HTTP(S) 协议。 */

/** 出站 URL 被拒绝时抛出；路由层映射为 400。 */
export class BlockedUrlError extends Error {}

export async function assertOutboundUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError("上游地址不是合法的 URL。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError("上游地址必须使用 http 或 https。");
  }
  if (!url.hostname) {
    throw new BlockedUrlError("上游地址缺少主机名。");
  }
  return url;
}
