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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold tracking-tight">财务</h1>

      <RedeemForm />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">历史兑换记录</CardTitle>
          <CardDescription>最近的 50 条兑换记录。</CardDescription>
        </CardHeader>
        <CardContent>
          {redemptions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">还没有兑换记录。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>卡密</TableHead>
                  <TableHead>套餐</TableHead>
                  <TableHead>额度</TableHead>
                  <TableHead className="text-right">有效期</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {redemptions.map((redemption) => (
                  <TableRow key={redemption._id}>
                    <TableCell className="whitespace-nowrap">{formatDateTime(redemption.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{redemption.cardCode}</TableCell>
                    <TableCell>{redemption.planName}</TableCell>
                    <TableCell className="tabular-nums">+{formatTokens(redemption.quotaTokens)}</TableCell>
                    <TableCell className="text-right tabular-nums">{redemption.validityDays} 天</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
