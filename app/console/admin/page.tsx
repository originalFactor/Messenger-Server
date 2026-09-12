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
import { requireAdminUser } from "@/lib/auth";
import { formatDateTime, formatTokens } from "@/lib/format";
import { getSiteOverview } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const admin = await requireAdminUser();
  if (!admin) {
    redirect("/console");
  }

  const overview = await getSiteOverview();

  return (
    <>
      <div className="topbar">
        <h1 style={{ margin: 0, fontSize: "1.5rem" }}>全站概览</h1>
      </div>

      <div className="stats-grid">
        <div className="panel">
          <div className="stat-label">用户总数</div>
          <div className="stat-value">{overview.users.total}</div>
          <div className="stat-sub">管理员 {overview.users.admins} · 近 24h 新增 {overview.users.newToday}</div>
        </div>
        <div className="panel">
          <div className="stat-label">近 24h 用量</div>
          <div className="stat-value">{overview.usage.today.requests}</div>
          <div className="stat-sub">{formatTokens(overview.usage.today.tokens)} tokens · 消耗 {formatTokens(overview.usage.today.cost)}</div>
        </div>
        <div className="panel">
          <div className="stat-label">近 7 天用量</div>
          <div className="stat-value">{overview.usage.week.requests}</div>
          <div className="stat-sub">{formatTokens(overview.usage.week.tokens)} tokens · 消耗 {formatTokens(overview.usage.week.cost)}</div>
        </div>
        <div className="panel">
          <div className="stat-label">卡密</div>
          <div className="stat-value">{overview.cards.total}</div>
          <div className="stat-sub">未用 {overview.cards.unused} · 已用 {overview.cards.redeemed} · 停用 {overview.cards.disabled}</div>
        </div>
        <div className="panel">
          <div className="stat-label">套餐</div>
          <div className="stat-value">{overview.plans.enabled}/{overview.plans.total}</div>
          <div className="stat-sub">启用中 / 总数</div>
        </div>
        <div className="panel">
          <div className="stat-label">上游</div>
          <div className="stat-value">{overview.upstreams.enabled}/{overview.upstreams.total}</div>
          <div className="stat-sub">启用中 / 总数</div>
        </div>
      </div>

      <div className="row" style={{ alignItems: "stretch" }}>
        <div className="panel" style={{ flex: 1, minWidth: 280 }}>
          <div className="kicker">最新注册用户</div>
          {overview.recentUsers.length === 0 ? (
            <p className="muted">暂无用户。</p>
          ) : (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>邮箱</th>
                    <th>角色</th>
                    <th>注册时间</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recentUsers.map((user) => (
                    <tr key={user.id}>
                      <td>{user.email}</td>
                      <td>
                        <span className={user.role === "admin" ? "badge badge-accent" : "badge"}>
                          {user.role === "admin" ? "管理员" : "用户"}
                        </span>
                      </td>
                      <td>{formatDateTime(user.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel" style={{ flex: 1, minWidth: 280 }}>
          <div className="kicker">全站近期调用</div>
          {overview.recentUsage.length === 0 ? (
            <p className="muted">暂无调用记录。</p>
          ) : (
            <div className="table-wrap" style={{ marginTop: 12 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>模型</th>
                    <th>tokens</th>
                    <th>额度</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recentUsage.map((log) => (
                    <tr key={log._id}>
                      <td>{formatDateTime(log.createdAt)}</td>
                      <td className="mono">{log.modelId}</td>
                      <td>{formatTokens(log.totalTokens)}</td>
                      <td>{log.cost}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
