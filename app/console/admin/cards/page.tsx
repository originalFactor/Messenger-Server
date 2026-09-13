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

import { redirect } from "next/navigation";
import { CardsManager } from "@/components/admin/cards-manager";
import { requireAdminUser } from "@/lib/auth";
import { listPlans } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function AdminCardsPage() {
  const admin = await requireAdminUser();
  if (!admin) {
    redirect("/console");
  }

  const plans = await listPlans();

  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold tracking-tight">开卡</h1>
      <CardsManager plans={plans} />
    </div>
  );
}
