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
import type { AiModelDoc, UpstreamDoc } from "@/lib/types";

interface UpstreamFormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string;
  priority: string;
  enabled: boolean;
}

const emptyUpstreamForm: UpstreamFormState = {
  name: "",
  baseUrl: "",
  apiKey: "",
  models: "",
  priority: "0",
  enabled: true,
};

export function UpstreamsManager({
  upstreams,
  models,
}: {
  upstreams: UpstreamDoc[];
  models: AiModelDoc[];
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<UpstreamFormState>(emptyUpstreamForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [probeResults, setProbeResults] = useState<Record<string, string[]>>({});
  const [probingId, setProbingId] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);

  const [newModelId, setNewModelId] = useState("");
  const [modelEdits, setModelEdits] = useState<Record<string, { rate: string; enabled: boolean }>>({});

  function startCreate() {
    setEditingId(null);
    setForm(emptyUpstreamForm);
    setShowForm(true);
    setError(null);
  }

  function startEdit(upstream: UpstreamDoc) {
    setEditingId(upstream._id);
    setForm({
      name: upstream.name,
      baseUrl: upstream.baseUrl,
      apiKey: upstream.apiKey,
      models: upstream.models.join("\n"),
      priority: String(upstream.priority),
      enabled: upstream.enabled,
    });
    setShowForm(true);
    setError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const modelList = form.models.split(/[\n,]/).map((model) => model.trim()).filter(Boolean);
    const payload = {
      name: form.name,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
      models: modelList,
      priority: Number(form.priority) || 0,
      enabled: form.enabled,
    };
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(editingId ? `/api/admin/upstreams/${editingId}` : "/api/admin/upstreams", {
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

  async function removeUpstream(upstream: UpstreamDoc) {
    if (!window.confirm(`确定删除上游「${upstream.name}」？`)) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/upstreams/${upstream._id}`, { method: "DELETE" });
      if (!response.ok) {
        setError("删除失败。");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function probe(upstream: UpstreamDoc) {
    setProbingId(upstream._id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/upstreams/${upstream._id}/probe`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as { models?: string[]; error?: string } | null;
      if (!response.ok || !payload?.models) {
        setError(payload?.error ?? "探测失败。");
        return;
      }
      setProbeResults((results) => ({ ...results, [upstream._id]: payload.models ?? [] }));
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setProbingId(null);
    }
  }

  async function importModels(upstream: UpstreamDoc) {
    const modelIds = probeResults[upstream._id];
    if (!modelIds || modelIds.length === 0) {
      return;
    }
    setImportingId(upstream._id);
    setError(null);
    try {
      const response = await fetch("/api/admin/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelIds }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "导入失败。");
        return;
      }
      router.refresh();
    } finally {
      setImportingId(null);
    }
  }

  async function saveModelEdit(model: AiModelDoc) {
    const edit = modelEdits[model._id];
    if (!edit) {
      return;
    }
    const rate = Number(edit.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      setError("倍率必须是正数。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/models/${encodeURIComponent(model._id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate, enabled: edit.enabled }),
      });
      if (!response.ok) {
        setError("保存失败。");
        return;
      }
      setModelEdits((edits) => {
        const next = { ...edits };
        delete next[model._id];
        return next;
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function toggleModel(model: AiModelDoc) {
    setBusy(true);
    try {
      await fetch(`/api/admin/models/${encodeURIComponent(model._id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !model.enabled }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function deleteModel(model: AiModelDoc) {
    if (!window.confirm(`确定从目录删除模型 ${model._id}？`)) {
      return;
    }
    setBusy(true);
    try {
      await fetch(`/api/admin/models/${encodeURIComponent(model._id)}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function addModel(event: React.FormEvent) {
    event.preventDefault();
    if (!newModelId.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/admin/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelIds: [newModelId.trim()] }),
      });
      setNewModelId("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="toolbar">
        <button className="button" type="button" onClick={startCreate}>新增上游</button>
      </div>

      {showForm ? (
        <div className="panel" style={{ marginBottom: 20 }}>
          <div className="kicker">{editingId ? "编辑上游" : "新增上游"}</div>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: ".88rem" }}>
            Base URL 填 OpenAI 兼容根地址（含 /v1），例如 <span className="mono">https://api.example.com/v1</span>；
            优先级数字越小越优先，同模型多个上游时自动故障转移。
          </p>
          <form className="toolbar" style={{ marginTop: 14, alignItems: "flex-start" }} onSubmit={submit}>
            <div className="field">
              <label>名称</label>
              <input className="input" required value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </div>
            <div className="field" style={{ minWidth: 280 }}>
              <label>Base URL</label>
              <input className="input" required type="url" placeholder="https://api.example.com/v1" value={form.baseUrl}
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
            </div>
            <div className="field">
              <label>API Key</label>
              <input className="input" value={form.apiKey}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
            </div>
            <div className="field">
              <label>优先级</label>
              <input className="input" type="number" min={0} value={form.priority}
                onChange={(event) => setForm({ ...form, priority: event.target.value })} />
            </div>
            <div className="field">
              <label>启用</label>
              <select className="select" value={form.enabled ? "1" : "0"}
                onChange={(event) => setForm({ ...form, enabled: event.target.value === "1" })}>
                <option value="1">启用</option>
                <option value="0">停用</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1, minWidth: 280 }}>
              <label>可服务模型（每行一个，或逗号分隔）</label>
              <textarea className="textarea mono" value={form.models}
                onChange={(event) => setForm({ ...form, models: event.target.value })}
                placeholder={"gpt-4o\ndeepseek-chat"} />
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

      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="kicker">上游列表</div>
        {upstreams.length === 0 ? (
          <p className="muted">还没有上游，点击「新增上游」添加第一个模型服务。</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>Base URL</th>
                  <th>优先级</th>
                  <th>模型数</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {upstreams.map((upstream) => (
                  <tr key={upstream._id}>
                    <td>{upstream.name}</td>
                    <td className="mono" style={{ maxWidth: 260, overflowWrap: "anywhere" }}>{upstream.baseUrl}</td>
                    <td>{upstream.priority}</td>
                    <td>{upstream.models.length}</td>
                    <td>
                      <span className={upstream.enabled ? "badge badge-ok" : "badge"}>
                        {upstream.enabled ? "启用" : "停用"}
                      </span>
                    </td>
                    <td>
                      <div className="actions">
                        <button className="button-secondary button-small" type="button" onClick={() => startEdit(upstream)}>编辑</button>
                        <button className="button-secondary button-small" type="button" disabled={probingId === upstream._id}
                          onClick={() => probe(upstream)}>
                          {probingId === upstream._id ? "探测中…" : "测试"}
                        </button>
                        <button className="button-danger button-small" type="button" disabled={busy}
                          onClick={() => removeUpstream(upstream)}>删除</button>
                      </div>
                      {probeResults[upstream._id] ? (
                        <div className="notice" style={{ marginTop: 10 }}>
                          <div className="row" style={{ marginBottom: 8 }}>
                            <strong>发现 {probeResults[upstream._id].length} 个模型</strong>
                            <button className="button button-small" type="button" disabled={importingId === upstream._id}
                              onClick={() => importModels(upstream)}>
                              {importingId === upstream._id ? "导入中…" : "全部导入目录（默认 1.0 倍率）"}
                            </button>
                          </div>
                          <div className="mono" style={{ maxHeight: 120, overflowY: "auto", fontSize: ".8rem" }}>
                            {probeResults[upstream._id].join(", ")}
                          </div>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="topbar" style={{ marginBottom: 8 }}>
          <div className="kicker">模型倍率目录</div>
          <form className="row" onSubmit={addModel}>
            <input className="input mono" style={{ width: 240 }} placeholder="model-id"
              value={newModelId} onChange={(event) => setNewModelId(event.target.value)} />
            <button className="button-secondary button-small" type="submit" disabled={busy || !newModelId.trim()}>
              添加模型
            </button>
          </form>
        </div>
        <p className="muted" style={{ margin: "0 0 12px", fontSize: ".88rem" }}>
          只有目录中启用且至少一个启用上游可服务的模型，才会出现在 AI API 的 /v1/models 中。
          消耗额度 = ceil(tokens × 倍率)。
        </p>
        {models.length === 0 ? (
          <p className="muted">目录为空，可通过上游「测试」一键导入，或手动添加。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>模型 ID</th>
                  <th>倍率</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => {
                  const edit = modelEdits[model._id] ?? { rate: String(model.rate), enabled: model.enabled };
                  const dirty = Number(edit.rate) !== model.rate || edit.enabled !== model.enabled;
                  return (
                    <tr key={model._id}>
                      <td className="mono">{model._id}</td>
                      <td>
                        <input className="input" style={{ width: 100 }} type="number" step="0.1" min={0.1}
                          value={edit.rate}
                          onChange={(event) => setModelEdits((edits) => ({
                            ...edits,
                            [model._id]: { ...edit, rate: event.target.value },
                          }))} />
                      </td>
                      <td>
                        <select className="select" style={{ width: 100 }} value={edit.enabled ? "1" : "0"}
                          onChange={(event) => setModelEdits((edits) => ({
                            ...edits,
                            [model._id]: { ...edit, enabled: event.target.value === "1" },
                          }))}>
                          <option value="1">启用</option>
                          <option value="0">停用</option>
                        </select>
                      </td>
                      <td>
                        <div className="actions">
                          <button className="button button-small" type="button" disabled={!dirty || busy}
                            onClick={() => saveModelEdit(model)}>保存</button>
                          <button className="button-secondary button-small" type="button" disabled={busy}
                            onClick={() => toggleModel(model)}>启用/停用</button>
                          <button className="button-danger button-small" type="button" disabled={busy}
                            onClick={() => deleteModel(model)}>删除</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
