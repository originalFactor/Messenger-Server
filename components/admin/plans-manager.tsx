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

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatTokens } from "@/lib/format";
import type { PlanDoc } from "@/lib/types";

interface PlanFormState {
  name: string;
  description: string;
  quotaTokens: string;
  validityDays: string;
  price: string;
  enabled: boolean;
  sortOrder: string;
}

const emptyForm: PlanFormState = {
  name: "",
  description: "",
  quotaTokens: "",
  validityDays: "",
  price: "",
  enabled: true,
  sortOrder: "0",
};

export function PlansManager({ plans }: { plans: PlanDoc[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PlanFormState>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
    setError(null);
  }

  function startEdit(plan: PlanDoc) {
    setEditingId(plan._id);
    setForm({
      name: plan.name,
      description: plan.description ?? "",
      quotaTokens: String(plan.quotaTokens),
      validityDays: String(plan.validityDays),
      price: plan.price ?? "",
      enabled: plan.enabled,
      sortOrder: String(plan.sortOrder),
    });
    setShowForm(true);
    setError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const payload = {
      name: form.name,
      description: form.description || null,
      quotaTokens: Number(form.quotaTokens),
      validityDays: Number(form.validityDays),
      price: form.price || null,
      enabled: form.enabled,
      sortOrder: Number(form.sortOrder) || 0,
    };
    if (!Number.isFinite(payload.quotaTokens) || payload.quotaTokens <= 0) {
      setError("额度必须是正整数。");
      return;
    }
    if (!Number.isFinite(payload.validityDays) || payload.validityDays <= 0) {
      setError("有效天数必须是正整数。");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(editingId ? `/api/admin/plans/${editingId}` : "/api/admin/plans", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "保存失败，请稍后重试。");
        return;
      }
      setShowForm(false);
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function remove(plan: PlanDoc) {
    if (!window.confirm(`确定删除套餐「${plan.name}」？已发出的卡密仍可按开出时的内容兑换。`)) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/plans/${plan._id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "删除失败。");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="toolbar">
        <button className="button" type="button" onClick={startCreate}>新建套餐</button>
      </div>

      {showForm ? (
        <div className="panel" style={{ marginBottom: 20 }}>
          <div className="kicker">{editingId ? "编辑套餐" : "新建套餐"}</div>
          <form className="toolbar" style={{ marginTop: 14, alignItems: "flex-start" }} onSubmit={submit}>
            <div className="field">
              <label>名称</label>
              <input className="input" required value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </div>
            <div className="field">
              <label>额度（tokens）</label>
              <input className="input" required type="number" min={1} value={form.quotaTokens}
                onChange={(event) => setForm({ ...form, quotaTokens: event.target.value })} />
            </div>
            <div className="field">
              <label>有效期（天）</label>
              <input className="input" required type="number" min={1} value={form.validityDays}
                onChange={(event) => setForm({ ...form, validityDays: event.target.value })} />
            </div>
            <div className="field">
              <label>价格文案（选填）</label>
              <input className="input" placeholder="¥9.9" value={form.price}
                onChange={(event) => setForm({ ...form, price: event.target.value })} />
            </div>
            <div className="field">
              <label>排序</label>
              <input className="input" type="number" min={0} value={form.sortOrder}
                onChange={(event) => setForm({ ...form, sortOrder: event.target.value })} />
            </div>
            <div className="field">
              <label>描述（选填）</label>
              <input className="input" value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })} />
            </div>
            <div className="field">
              <label>启用</label>
              <select className="select" value={form.enabled ? "1" : "0"}
                onChange={(event) => setForm({ ...form, enabled: event.target.value === "1" })}>
                <option value="1">启用</option>
                <option value="0">停用</option>
              </select>
            </div>
            <div className="field">
              <label>&nbsp;</label>
              <div className="row">
                <button className="button" type="submit" disabled={busy}>{editingId ? "保存" : "创建"}</button>
                <button className="button-secondary" type="button" onClick={() => setShowForm(false)}>取消</button>
              </div>
            </div>
          </form>
          {error ? <p className="error">{error}</p> : null}
        </div>
      ) : null}

      <div className="panel">
        {plans.length === 0 ? (
          <p className="muted">还没有套餐，点击「新建套餐」创建第一个。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>额度</th>
                  <th>有效期</th>
                  <th>价格文案</th>
                  <th>排序</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan._id}>
                    <td>{plan.name}{plan.description ? <div className="muted" style={{ fontSize: ".84rem" }}>{plan.description}</div> : null}</td>
                    <td>{formatTokens(plan.quotaTokens)}</td>
                    <td>{plan.validityDays} 天</td>
                    <td>{plan.price || "—"}</td>
                    <td>{plan.sortOrder}</td>
                    <td>
                      <span className={plan.enabled ? "badge badge-ok" : "badge"}>
                        {plan.enabled ? "启用" : "停用"}
                      </span>
                    </td>
                    <td>
                      <div className="actions">
                        <button className="button-secondary button-small" type="button" onClick={() => startEdit(plan)}>编辑</button>
                        <button className="button-danger button-small" type="button" onClick={() => remove(plan)} disabled={busy}>删除</button>
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
