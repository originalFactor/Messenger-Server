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

/**
 * 额度估算与计费。额度单位与 token 1:1，输入/输出分别乘以各自倍率：
 *   cost = max(1, ceil(promptTokens × inputRate + completionTokens × outputRate))
 * 上游未返回 usage 时按英文文本经验值（约 4 字符/token）估算。
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function safeRateOrZero(rate: number | null | undefined): number {
  return Number.isFinite(rate) && rate !== undefined && rate !== null && rate > 0 ? rate : 0;
}

export function computeCost(
  promptTokens: number,
  completionTokens: number,
  inputRate: number | null | undefined,
  outputRate: number | null | undefined,
): number {
  const ir = safeRateOrZero(inputRate);
  const or = safeRateOrZero(outputRate);
  // 双倍率置零 = 不限制 / 不计费。
  if (ir <= 0 && or <= 0) {
    return 0;
  }
  const prompt = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
  const completion = Number.isFinite(completionTokens) && completionTokens > 0 ? completionTokens : 0;
  return Math.max(1, Math.ceil(prompt * ir + completion * or));
}

export interface QuotaState {
  balance: number;
  expiresAt: number | null;
  available: boolean;
  reason: "no_quota" | "expired" | null;
}

export function quotaState(balance: number, expiresAt: number | null, now = Date.now()): QuotaState {
  if (expiresAt === null) {
    return { balance, expiresAt, available: false, reason: "no_quota" };
  }
  if (expiresAt <= now) {
    return { balance, expiresAt, available: false, reason: "expired" };
  }
  if (balance <= 0) {
    return { balance, expiresAt, available: false, reason: "no_quota" };
  }
  return { balance, expiresAt, available: true, reason: null };
}
