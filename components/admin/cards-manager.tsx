"use client";

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

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDateTime, formatTokens } from "@/lib/format";
import type { CardKeyDoc, PlanDoc } from "@/lib/types";

const statusLabels: Record<CardKeyDoc["status"], string> = {
  unused: "未使用",
  redeemed: "已兑换",
  disabled: "已停用",
};

export function CardsManager({ plans }: { plans: PlanDoc[] }) {
  const router = useRouter();
  const [planId, setPlanId] = useState(plans[0]?._id ?? "");
  const [count, setCount] = useState("10");
  const [note, setNote] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<CardKeyDoc[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<"" | CardKeyDoc["status"]>("");
  const [cards, setCards] = useState<CardKeyDoc[]>([]);
  const [loadingCards, setLoadingCards] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);

  const loadCards = useCallback(async () => {
    setLoadingCards(true);
    try {
      const query = statusFilter ? `?status=${statusFilter}` : "";
      const response = await fetch(`/api/admin/cards${query}`);
      if (response.ok) {
        const payload = (await response.json()) as { cards: CardKeyDoc[] };
        setCards(payload.cards);
      }
    } finally {
      setLoadingCards(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void loadCards();
  }, [loadCards]);

  async function issue(event: React.FormEvent) {
    event.preventDefault();
    setIssuing(true);
    setError(null);
    setIssued(null);
    try {
      const response = await fetch("/api/admin/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, count: Number(count), note: note || null }),
      });
      const payload = (await response.json().catch(() => null)) as { cards?: CardKeyDoc[]; error?: string } | null;
      if (!response.ok || !payload?.cards) {
        setError(payload?.error ?? "开卡失败，请稍后重试。");
        return;
      }
      setIssued(payload.cards);
      await loadCards();
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setIssuing(false);
    }
  }

  async function copyIssued() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.map((card) => card.code).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("复制失败，请手动选择复制。");
    }
  }

  async function disableCard(card: CardKeyDoc) {
    setActionBusy(true);
    try {
      const response = await fetch(`/api/admin/cards/${card._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "disabled" }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "停用失败。");
        return;
      }
      await loadCards();
    } finally {
      setActionBusy(false);
    }
  }

  async function deleteCard(card: CardKeyDoc) {
    if (!window.confirm(`确定删除卡密 ${card.code}？`)) {
      return;
    }
    setActionBusy(true);
    try {
      const response = await fetch(`/api/admin/cards/${card._id}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "删除失败。");
        return;
      }
      await loadCards();
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <>
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="kicker">批量开卡</div>
        {plans.length === 0 ? (
          <p className="muted">请先在「套餐管理」中创建套餐。</p>
        ) : (
          <form className="toolbar" style={{ marginTop: 14 }} onSubmit={issue}>
            <div className="field">
              <label>套餐</label>
              <select className="select" value={planId} onChange={(event) => setPlanId(event.target.value)}>
                {plans.map((plan) => (
                  <option key={plan._id} value={plan._id}>
                    {plan.name}（{formatTokens(plan.quotaTokens)} / {plan.validityDays} 天）
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>数量（1-500）</label>
              <input className="input" type="number" min={1} max={500} required value={count}
                onChange={(event) => setCount(event.target.value)} />
            </div>
            <div className="field">
              <label>备注（选填）</label>
              <input className="input" value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
            <button className="button" type="submit" disabled={issuing}>
              {issuing ? "开卡中…" : "生成卡密"}
            </button>
          </form>
        )}
        {error ? <p className="error">{error}</p> : null}
        {issued ? (
          <div className="notice" style={{ marginTop: 12 }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <strong>成功生成 {issued.length} 张卡密（请立即保存，仅此次完整展示）：</strong>
              <button className="button-secondary button-small" type="button" onClick={copyIssued}>
                {copied ? "已复制" : "复制全部"}
              </button>
            </div>
            <div className="mono" style={{ lineHeight: 1.8 }}>
              {issued.map((card) => <div key={card._id}>{card.code}</div>)}
            </div>
          </div>
        ) : null}
      </div>

      <div className="panel">
        <div className="topbar" style={{ marginBottom: 8 }}>
          <div className="kicker">卡密列表</div>
          <select className="select" style={{ width: 140 }}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as "" | CardKeyDoc["status"])}>
            <option value="">全部状态</option>
            <option value="unused">未使用</option>
            <option value="redeemed">已兑换</option>
            <option value="disabled">已停用</option>
          </select>
        </div>
        {loadingCards ? (
          <p className="muted">加载中…</p>
        ) : cards.length === 0 ? (
          <p className="muted">没有符合条件的卡密。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>卡密</th>
                  <th>套餐</th>
                  <th>额度</th>
                  <th>状态</th>
                  <th>备注</th>
                  <th>创建时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((card) => (
                  <tr key={card._id}>
                    <td className="mono">{card.code}</td>
                    <td>{card.planName}</td>
                    <td>{formatTokens(card.quotaTokens)}</td>
                    <td>
                      <span className={card.status === "unused" ? "badge badge-ok" : card.status === "redeemed" ? "badge" : "badge badge-danger"}>
                        {statusLabels[card.status]}
                      </span>
                    </td>
                    <td>{card.note || "—"}</td>
                    <td>{formatDateTime(card.createdAt)}</td>
                    <td>
                      <div className="actions">
                        {card.status === "unused" ? (
                          <button className="button-secondary button-small" type="button" disabled={actionBusy}
                            onClick={() => disableCard(card)}>停用</button>
                        ) : null}
                        {card.status !== "redeemed" ? (
                          <button className="button-danger button-small" type="button" disabled={actionBusy}
                            onClick={() => deleteCard(card)}>删除</button>
                        ) : null}
                      </div>
                    </td>
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
