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

import { issueRegistrationCode, REGISTRATION_CODE_TTL_MS } from "@/lib/auth-tokens";
import { jsonError, jsonOk } from "@/lib/http";
import { mailEnabled, sendRegistrationCode } from "@/lib/mail";
import { clientIp, enforceRateLimits } from "@/lib/rate-limit";
import { forgotPasswordSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!mailEnabled()) {
    return jsonError("Email delivery is not configured on this server. Contact the administrator.", 503);
  }
  const parsed = forgotPasswordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("A valid email is required.", 400);
  const { email } = parsed.data;
  const limited = await enforceRateLimits([
    { rule: { bucket: "register-code-ip", limit: 10, windowMs: 60 * 60 * 1000 }, identity: clientIp(request) },
    { rule: { bucket: "register-code-email", limit: 3, windowMs: 60 * 60 * 1000 }, identity: email },
    { rule: { bucket: "register-code-cooldown", limit: 1, windowMs: 60 * 1000 }, identity: email },
  ]);
  if (limited) return limited;
  const code = await issueRegistrationCode(email);
  if (!(await sendRegistrationCode(email, code, REGISTRATION_CODE_TTL_MS / 60_000))) {
    return jsonError("Unable to send the verification code. Please try again later.", 503);
  }
  return jsonOk({ success: true });
}
