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
import { RedeemForm } from "@/components/console/redeem-form";
import { requireUserSession } from "@/lib/auth";
import { formatDateTime, formatTokens } from "@/lib/format";
import { listRedemptions } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function ConsoleFinancePage() {
  const session = await requireUserSession();
  if (!session) {
    redirect("/login");
  }

  const redemptions = await listRedemptions(session.sub, 50);

  return (
    <>
      <div className="topbar">
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>财务</h1>
      </div>

      <RedeemForm />

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="kicker">历史兑换记录</div>
        {redemptions.length === 0 ? (
          <p className="muted">还没有兑换记录。</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>卡密</th>
                  <th>套餐</th>
                  <th>额度</th>
                  <th>有效期</th>
                </tr>
              </thead>
              <tbody>
                {redemptions.map((redemption) => (
                  <tr key={redemption._id}>
                    <td>{formatDateTime(redemption.createdAt)}</td>
                    <td className="mono">{redemption.cardCode}</td>
                    <td>{redemption.planName}</td>
                    <td>+{formatTokens(redemption.quotaTokens)}</td>
                    <td>{redemption.validityDays} 天</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
