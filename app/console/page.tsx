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
import { ApiKeyCard } from "@/components/console/api-key-card";
import { requireUserSession } from "@/lib/auth";
import { formatDateTime, formatTokens } from "@/lib/format";
import { quotaState } from "@/lib/quota";
import { getUserById, listUsageLogs, sumUsage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function ConsoleOverviewPage() {
  const session = await requireUserSession();
  if (!session) {
    redirect("/login");
  }
  const user = await getUserById(session.sub);
  if (!user) {
    redirect("/login");
  }

  const now = Date.now();
  const [today, recentUsage] = await Promise.all([
    sumUsage(user.id, now - 24 * 60 * 60 * 1000),
    listUsageLogs(user.id, 10),
  ]);
  const quota = quotaState(user.quotaBalance, user.quotaExpiresAt, now);

  return (
    <>
      <div className="topbar">
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>概览</h1>
        <span className="badge badge-accent">{user.role === "admin" ? "管理员" : "用户"}</span>
      </div>

      <div className="stats-grid">
        <div className="panel">
          <div className="stat-label">剩余额度</div>
          <div className="stat-value">{formatTokens(quota.balance)}</div>
          <div className="stat-sub">
            {quota.available
              ? `有效期至 ${formatDateTime(quota.expiresAt ?? 0)}`
              : quota.reason === "expired"
                ? "套餐已过期，请兑换新卡密"
                : "暂无可用额度，请兑换卡密"}
          </div>
        </div>
        <div className="panel">
          <div className="stat-label">近 24 小时请求</div>
          <div className="stat-value">{today.requests}</div>
          <div className="stat-sub">消耗 {formatTokens(today.cost)} 额度</div>
        </div>
        <div className="panel">
          <div className="stat-label">近 24 小时 tokens</div>
          <div className="stat-value">{formatTokens(today.tokens)}</div>
          <div className="stat-sub">按模型倍率折算</div>
        </div>
      </div>

      <ApiKeyCard apiKey={user.aiApiKey} />

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="kicker">近期用量</div>
        {recentUsage.length === 0 ? (
          <p className="muted">暂无调用记录。在 Messenger 中使用 Messenger Cloud AI 服务商发起对话后，这里会展示明细。</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模型</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>消耗额度</th>
                  <th>方式</th>
                </tr>
              </thead>
              <tbody>
                {recentUsage.map((log) => (
                  <tr key={log._id}>
                    <td>{formatDateTime(log.createdAt)}</td>
                    <td className="mono">{log.modelId}</td>
                    <td>{formatTokens(log.promptTokens)}</td>
                    <td>{formatTokens(log.completionTokens)}</td>
                    <td>{log.cost}</td>
                    <td>{log.stream ? "流式" : "非流式"}</td>
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
