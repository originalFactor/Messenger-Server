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

import { createTranslator, type Translator } from "@/lib/i18n";

/**
 * 计价原语：四种 token 腿（输入 / 缓存读取 / 缓存写入 / 输出）、长上下文
 * 阶梯价与峰谷（时段）计费。服务端（倍率解析、计费、探测）与
 * 控制台共用同一套语义，避免展示口径与实际扣费漂移。
 *
 * 时间一律用 UTC：峰谷时段按 UTC 分钟表示（0–1440，起始含、结束不含），
 * 星期按 0 = 周日。
 */

/** 四种 token 腿的倍率/价格。 */
export interface TokenRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const TOKEN_RATE_LEGS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type TokenRateLeg = (typeof TOKEN_RATE_LEGS)[number];

/**
 * 长上下文阶梯：提示总量超过阈值（`inputThresholdInclusive` 时为达到）
 * 后，整次请求按该档的四种腿计价。
 */
export interface LongContextTier extends TokenRates {
  inputThreshold: number;
  /** 默认 false = 严格超过阈值才生效。 */
  inputThresholdInclusive?: boolean;
}

/** 峰值时段：UTC 星期（周日 = 0），起始分钟含、结束分钟不含。 */
export interface PeakWindow {
  weekdays: number[];
  startMinute: number;
  endMinute: number;
}

/**
 * 峰谷计费：处于峰值时段按牌价，其余时间乘以 `offPeakMultiplier`。
 * `peakWindows` 为空 = 没有周期性谷时价（`offPeakMultiplier` 不生效）。
 */
export interface TimeBasedPricing {
  offPeakMultiplier: number;
  peakWindows: PeakWindow[];
}

/** 一张完整的价目卡：基础四腿 + 可选长上下文阶梯 + 可选峰谷。 */
export interface RateCard extends TokenRates {
  tiers?: LongContextTier[];
  timeBased?: TimeBasedPricing;
}

/** 一次请求实际生效的四条腿（已选档、已套峰谷折扣）。 */
export type EffectiveRates = TokenRates;

export const DAY_MINUTES = 24 * 60;

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 倍率有效化：有限且 > 0，否则 0（= 该腿不计费）。 */
export function rateOrZero(value: number | null | undefined): number {
  return finiteOrZero(value);
}

/** 窗口合法性：星期 0–6 且不重复，起始 < 结束且都在一天内。 */
export function isValidPeakWindow(window: PeakWindow): boolean {
  if (!Array.isArray(window.weekdays) || window.weekdays.length === 0) {
    return false;
  }
  const weekdays = new Set(window.weekdays);
  if (weekdays.size !== window.weekdays.length) {
    return false;
  }
  if ([...weekdays].some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    return false;
  }
  const { startMinute, endMinute } = window;
  return (
    Number.isInteger(startMinute)
    && Number.isInteger(endMinute)
    && startMinute >= 0
    && endMinute <= DAY_MINUTES
    && startMinute < endMinute
  );
}

/** 只保留合法窗口（并归并重复星期、按星期排序）。 */
export function sanitizePeakWindows(windows: readonly PeakWindow[] | null | undefined): PeakWindow[] {
  if (!windows) {
    return [];
  }
  return windows
    .filter(isValidPeakWindow)
    .map((window) => ({
      weekdays: [...new Set(window.weekdays)].sort((a, b) => a - b),
      startMinute: window.startMinute,
      endMinute: window.endMinute,
    }));
}

/**
 * 有效峰谷配置：没有合法窗口时视为「无周期性谷时价」—— 避免留下「永远
 * 不会进入谷时」的空壳配置。
 */
export function normalizeTimeBased(pricing: TimeBasedPricing | null | undefined): TimeBasedPricing | undefined {
  if (!pricing) {
    return undefined;
  }
  const windows = sanitizePeakWindows(pricing.peakWindows);
  if (windows.length === 0) {
    return undefined;
  }
  const offPeak = Number.isFinite(pricing.offPeakMultiplier) && pricing.offPeakMultiplier >= 0
    ? pricing.offPeakMultiplier
    : 1;
  return { offPeakMultiplier: offPeak, peakWindows: windows };
}

/**
 * 阶梯规范化：阈值正数才保留；未填的腿沿用 `fallback`（基础档），这样
 * 只写阈值与部分价格的覆盖条目不会把其余腿打成 0。
 */
export function normalizeTiers(
  tiers: readonly LongContextTier[] | null | undefined,
  fallback: TokenRates,
): LongContextTier[] | undefined {
  if (!tiers || tiers.length === 0) {
    return undefined;
  }
  const byThreshold = new Map<number, LongContextTier>();
  for (const tier of tiers) {
    if (!Number.isFinite(tier.inputThreshold) || tier.inputThreshold <= 0) {
      continue;
    }
    byThreshold.set(tier.inputThreshold, {
      inputThreshold: tier.inputThreshold,
      ...(tier.inputThresholdInclusive !== undefined
        ? { inputThresholdInclusive: tier.inputThresholdInclusive }
        : {}),
      input: Number.isFinite(tier.input) ? tier.input : fallback.input,
      output: Number.isFinite(tier.output) ? tier.output : fallback.output,
      cacheRead: Number.isFinite(tier.cacheRead) ? tier.cacheRead : fallback.cacheRead,
      cacheWrite: Number.isFinite(tier.cacheWrite) ? tier.cacheWrite : fallback.cacheWrite,
    });
  }
  return byThreshold.size === 0
    ? undefined
    : [...byThreshold.values()].sort((a, b) => a.inputThreshold - b.inputThreshold);
}

/** 某一时刻是否落在任一峰值时段内。 */
export function isPeakTime(windows: readonly PeakWindow[], atMs: number): boolean {
  const date = new Date(atMs);
  const weekday = date.getUTCDay();
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return windows.some(
    (window) => window.weekdays.includes(weekday) && minute >= window.startMinute && minute < window.endMinute,
  );
}

/** 该时刻的峰谷系数：峰值 = 1，谷时 = `offPeakMultiplier`。 */
export function timeBasedMultiplier(pricing: TimeBasedPricing | undefined, atMs: number): number {
  if (!pricing || pricing.peakWindows.length === 0) {
    return 1;
  }
  if (isPeakTime(pricing.peakWindows, atMs)) {
    return 1;
  }
  return Number.isFinite(pricing.offPeakMultiplier) && pricing.offPeakMultiplier >= 0
    ? pricing.offPeakMultiplier
    : 1;
}

/** 提示总量命中的长上下文档：取满足条件的最高阈值档，无则 undefined。 */
export function selectLongContextTier(
  tiers: readonly LongContextTier[] | undefined,
  promptTokens: number,
): LongContextTier | undefined {
  if (!tiers || tiers.length === 0) {
    return undefined;
  }
  const prompt = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
  let chosen: LongContextTier | undefined;
  for (const tier of tiers) {
    const reached = tier.inputThresholdInclusive ? prompt >= tier.inputThreshold : prompt > tier.inputThreshold;
    if (!reached) {
      continue;
    }
    if (chosen === undefined || tier.inputThreshold > chosen.inputThreshold) {
      chosen = tier;
    }
  }
  return chosen;
}

/**
 * 一次请求实际生效的倍率：先按提示总量选长上下文档，再按请求时刻套峰谷
 * 系数（峰值 = 1，谷时 = offPeakMultiplier）。阈值与时段都只影响「这一次」
 * 的计价，不改任何存量配置。
 */
export function effectiveRates(
  card: RateCard,
  usage: { promptTokens: number; atMs: number },
): EffectiveRates {
  const tier = selectLongContextTier(card.tiers, usage.promptTokens);
  const legs: TokenRates = tier
    ? { input: tier.input, output: tier.output, cacheRead: tier.cacheRead, cacheWrite: tier.cacheWrite }
    : { input: card.input, output: card.output, cacheRead: card.cacheRead, cacheWrite: card.cacheWrite };
  const multiplier = timeBasedMultiplier(card.timeBased, usage.atMs);
  if (multiplier === 1) {
    return legs;
  }
  return {
    input: legs.input * multiplier,
    output: legs.output * multiplier,
    cacheRead: legs.cacheRead * multiplier,
    cacheWrite: legs.cacheWrite * multiplier,
  };
}

// ---------------------------------------------------------------------------
// 峰谷时段的文本编辑（控制台）
// ---------------------------------------------------------------------------

/**
 * 解析控制台的时段文本，每行一个窗口：`<星期> <开始>-<结束>`。
 * 星期写 `0-6`（0 = 周日）、`1-5` 或 `1,3,5`；时间为 UTC `HH:MM`。
 * 空文本 = 无周期性谷时价。非法行返回 `{ error }`，便于表单就地报错。
 */
export function parsePeakWindows(text: string, t: Translator = createTranslator("zh-CN")): { windows: PeakWindow[] } | { error: string } {
  const windows: PeakWindow[] = [];
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const match = /^([0-6](?:\s*[-,]\s*[0-6])*)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(line);
    if (!match) {
      return { error: t("无法解析时段「{0}」，格式应为「1-5 09:00-18:00」。", { "0": line }) };
    }
    const weekdays = parseWeekdays(match[1]);
    if (!weekdays) {
      return { error: t("时段「{0}」的星期无效（0–6，0 = 周日）。", { "0": line }) };
    }
    const startMinute = Number(match[2]) * 60 + Number(match[3]);
    const endMinute = Number(match[4]) * 60 + Number(match[5]);
    const window = { weekdays, startMinute, endMinute };
    if (!isValidPeakWindow(window)) {
      return { error: t("时段「{0}」的时间无效（UTC 00:00–24:00，开始须早于结束）。", { "0": line }) };
    }
    windows.push(window);
  }
  return { windows };
}

function parseWeekdays(text: string): number[] | null {
  const days = new Set<number>();
  for (const part of text.split(",").map((item) => item.trim())) {
    const range = /^([0-6])\s*-\s*([0-6])$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let day = from; day <= to; day += 1) {
        days.add(day);
      }
      continue;
    }
    if (!/^[0-6]$/.test(part)) {
      return null;
    }
    days.add(Number(part));
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

function formatWeekdays(weekdays: readonly number[]): string {
  const sorted = [...new Set(weekdays)].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return "";
  }
  // 连续区间折叠成 `a-b`，其余逐个列出。
  const parts: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const day of sorted.slice(1)) {
    if (day === previous + 1) {
      previous = day;
      continue;
    }
    parts.push(start === previous ? String(start) : `${start}-${previous}`);
    start = day;
    previous = day;
  }
  parts.push(start === previous ? String(start) : `${start}-${previous}`);
  return parts.join(",");
}

function formatMinute(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** 时段的文本表示（与 [parsePeakWindows] 互逆），供控制台回显。 */
export function formatPeakWindows(pricing: TimeBasedPricing | undefined): string {
  if (!pricing) {
    return "";
  }
  return pricing.peakWindows
    .map((window) =>
      `${formatWeekdays(window.weekdays)} ${formatMinute(window.startMinute)}-${formatMinute(window.endMinute)}`)
    .join("\n");
}
