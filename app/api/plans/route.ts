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

import { jsonOk } from "@/lib/http";
import { listPlans } from "@/lib/storage";

export const runtime = "nodejs";

/** 公开套餐列表，供官网定价区展示。未登录可访问。 */
export async function GET() {
  const plans = await listPlans({ enabledOnly: true });
  return jsonOk({
    plans: plans.map((plan) => ({
      id: plan._id,
      name: plan.name,
      description: plan.description ?? null,
      quotaTokens: plan.quotaTokens,
      validityDays: plan.validityDays,
      price: plan.price ?? null,
      sortOrder: plan.sortOrder,
    })),
  });
}
