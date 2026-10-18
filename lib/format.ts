/*
 * Copyright 2026 ECSDevs
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

/** 额度/token 展示：万、亿缩写。 */
export function formatTokens(tokens: number): string {
  if (tokens >= 100_000_000) {
    return `${(tokens / 100_000_000).toFixed(tokens % 100_000_000 === 0 ? 0 : 1)} 亿`;
  }
  if (tokens >= 10_000) {
    return `${(tokens / 10_000).toFixed(tokens % 10_000 === 0 ? 0 : 1)} 万`;
  }
  return String(tokens);
}

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatDateTime(ts: number): string {
  return dateTimeFormatter.format(new Date(ts));
}

export function formatDate(ts: number): string {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(ts));
}

/** 输出 TPS：completionTokens ÷ 耗时秒数；缺失/非正耗时或 0 输出时返回 —。 */
export function formatTps(completionTokens: number, durationMs: number | null | undefined): string {
  if (!Number.isFinite(durationMs) || !durationMs || durationMs <= 0 || completionTokens <= 0) {
    return "—";
  }
  const tps = completionTokens / (durationMs / 1000);
  return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
}
