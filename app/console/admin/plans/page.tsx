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
import { PlansManager } from "@/components/admin/plans-manager";
import { requireAdminUser } from "@/lib/auth";
import { listPlans } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function AdminPlansPage() {
  const admin = await requireAdminUser();
  if (!admin) {
    redirect("/console");
  }

  const plans = await listPlans();

  return (
    <>
      <div className="topbar">
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>套餐管理</h1>
      </div>
      <PlansManager plans={plans} />
    </>
  );
}
