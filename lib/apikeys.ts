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

import { randomBytes } from "node:crypto";

/**
 * 卡密字符集：去掉 0/O/1/I/L 等易混淆字符，方便人工抄写与电话报读。
 * 256 % 31 ≈ 4 的模偏差对随机卡密无实际影响，不做拒绝采样。
 */
const CARD_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export const CARD_CODE_PATTERN = /^MS-[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/;

/** 生成形如 MS-XXXXX-XXXXX-XXXXX 的卡密。 */
export function generateCardCode(): string {
  const bytes = randomBytes(15);
  let body = "";
  for (let i = 0; i < 15; i++) {
    body += CARD_ALPHABET[bytes[i] % CARD_ALPHABET.length];
  }
  return `MS-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}`;
}

/** 归一化用户输入的卡密：去空白、转大写。 */
export function normalizeCardCode(code: string): string {
  return code.trim().toUpperCase();
}

/** 生成用户级 AI API Key（OpenAI 风格 sk- 前缀 + 32 字符 base64url）。 */
export function generateAiApiKey(): string {
  return `sk-${randomBytes(24).toString("base64url")}`;
}
