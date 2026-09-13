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
import { Activity, Plus, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AiModelDoc, UpstreamDoc } from "@/lib/types";

interface UpstreamFormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  priority: string;
  enabled: string;
}

const emptyUpstreamForm: UpstreamFormState = {
  name: "",
  baseUrl: "",
  apiKey: "",
  priority: "0",
  enabled: "1",
};

type ContextSizes = Record<string, number>;

/** 展示形式：取能整除的最大单位（1000000 → 1M、1050000 → 1050K、500 → 500）。 */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${tokens / 1_000}K`;
  }
  return String(tokens);
}

/** 编辑形式：接受 1M / 1.05M / 272K / 200000（不区分大小写，最多两位小数），空串表示清除。 */
function parseContextInput(input: string): number | null | "invalid" {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) {
    return null;
  }
  const match = /^([0-9]+(\.[0-9]{1,2})?)\s*(K|M)?$/.exec(trimmed);
  if (!match) {
    return "invalid";
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return "invalid";
  }
  const tokens = Math.round(value * (match[2] === "K" ? 1_000 : match[2] === "M" ? 1_000_000 : 1));
  return tokens > 0 ? tokens : "invalid";
}

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
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [manualModel, setManualModel] = useState("");
  const [fetchingModels, setFetchingModels] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contextSizes, setContextSizes] = useState<ContextSizes>({});
  const [probeResults, setProbeResults] = useState<Record<string, string[]>>({});
  const [probingId, setProbingId] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);

  const [newModelId, setNewModelId] = useState("");
  const [modelEdits, setModelEdits] = useState<Record<string, { rate: string; context: string; enabled: boolean }>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/admin/models/metadata");
        if (!response.ok) return;
        const payload = (await response.json()) as {
          metadata?: Record<string, { contextWindow?: number }>;
        };
        if (cancelled) return;
        const sizes: ContextSizes = {};
        for (const [modelId, meta] of Object.entries(payload.metadata ?? {})) {
          if (typeof meta?.contextWindow === "number" && meta.contextWindow > 0) {
            sizes[modelId] = meta.contextWindow;
          }
        }
        setContextSizes(sizes);
      } catch {
        // 元数据仅用于展示，拉取失败静默降级。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const contextLabel = useCallback(
    (modelId: string): string | null => {
      const context = contextSizes[modelId];
      return context ? formatContext(context) : null;
    },
    [contextSizes],
  );

  function startCreate() {
    setEditingId(null);
    setForm(emptyUpstreamForm);
    setSelectedModels([]);
    setDiscoveredModels([]);
    setManualModel("");
    setFormError(null);
    setShowForm(true);
    setError(null);
  }

  function startEdit(upstream: UpstreamDoc) {
    setEditingId(upstream._id);
    setForm({
      name: upstream.name,
      baseUrl: upstream.baseUrl,
      apiKey: upstream.apiKey,
      priority: String(upstream.priority),
      enabled: upstream.enabled ? "1" : "0",
    });
    setSelectedModels([...upstream.models].sort((a, b) => a.localeCompare(b)));
    setDiscoveredModels([...upstream.models].sort((a, b) => a.localeCompare(b)));
    setManualModel("");
    setFormError(null);
    setShowForm(true);
    setError(null);
  }

  function toggleFormModel(modelId: string) {
    setSelectedModels((selected) =>
      selected.includes(modelId)
        ? selected.filter((value) => value !== modelId)
        : [...selected, modelId].sort((a, b) => a.localeCompare(b)),
    );
  }

  function addManualModel() {
    const modelId = manualModel.trim();
    if (!modelId) return;
    setDiscoveredModels((models_) =>
      models_.includes(modelId) ? models_ : [...models_, modelId].sort((a, b) => a.localeCompare(b)),
    );
    setSelectedModels((selected) =>
      selected.includes(modelId) ? selected : [...selected, modelId].sort((a, b) => a.localeCompare(b)),
    );
    setManualModel("");
  }

  async function fetchFormModels() {
    if (!form.baseUrl) {
      setFormError("请先填写 Base URL。");
      return;
    }
    setFetchingModels(true);
    setFormError(null);
    try {
      const response = await fetch("/api/admin/upstreams/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: form.baseUrl, apiKey: form.apiKey }),
      });
      const payload = (await response.json().catch(() => null)) as {
        models?: string[];
        contextSizes?: ContextSizes;
        error?: string;
      } | null;
      if (!response.ok || !payload?.models) {
        setFormError(payload?.error ?? "拉取失败，请稍后重试。");
        return;
      }
      if (payload.contextSizes) {
        setContextSizes((sizes) => ({ ...sizes, ...payload.contextSizes }));
      }
      setDiscoveredModels((models_) =>
        [...new Set([...models_, ...payload.models ?? []])].sort((a, b) => a.localeCompare(b)),
      );
      toast.success(`发现 ${payload.models.length} 个模型，勾选后保存即可`);
    } catch {
      setFormError("网络错误，请稍后重试。");
    } finally {
      setFetchingModels(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const payload = {
      name: form.name,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
      models: selectedModels,
      priority: Number(form.priority) || 0,
      enabled: form.enabled === "1",
    };
    setBusy(true);
    setFormError(null);
    try {
      const response = await fetch(editingId ? `/api/admin/upstreams/${editingId}` : "/api/admin/upstreams", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setFormError(body?.error ?? "保存失败，请稍后重试。");
        return;
      }
      setShowForm(false);
      router.refresh();
    } catch {
      setFormError("网络错误，请稍后重试。");
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
      const payload = (await response.json().catch(() => null)) as {
        models?: string[];
        contextSizes?: ContextSizes;
        error?: string;
      } | null;
      if (!response.ok || !payload?.models) {
        setError(payload?.error ?? "探测失败。");
        return;
      }
      if (payload.contextSizes) {
        setContextSizes((sizes) => ({ ...sizes, ...payload.contextSizes }));
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
      toast.success(`已导入 ${modelIds.length} 个模型（默认 1.0 倍率）`);
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
    const context = parseContextInput(edit.context);
    if (context === "invalid") {
      setError("上下文格式无效，请使用 272K / 1M 等形式。");
      return;
    }
    const baselineContext = model.contextWindow ?? contextSizes[model._id] ?? null;
    if (rate === model.rate && edit.enabled === model.enabled && context === baselineContext) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/models/${encodeURIComponent(model._id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate, enabled: edit.enabled, contextWindow: context }),
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

  const sortedDiscovered = [...discoveredModels].sort((a, b) => {
    const selectedFirst = Number(selectedModels.includes(b)) - Number(selectedModels.includes(a));
    return selectedFirst !== 0 ? selectedFirst : a.localeCompare(b);
  });
  const selectedDiscoveredCount = discoveredModels.filter((modelId) => selectedModels.includes(modelId)).length;
  const allDiscoveredSelected = discoveredModels.length > 0 && selectedDiscoveredCount === discoveredModels.length;
  const someDiscoveredSelected = selectedDiscoveredCount > 0 && !allDiscoveredSelected;

  function toggleAllDiscovered() {
    setSelectedModels(
      allDiscoveredSelected ? [] : [...discoveredModels].sort((a, b) => a.localeCompare(b)),
    );
  }

  return (
    <div className="grid gap-4">
      <div>
        <Button onClick={startCreate}>
          <Plus />
          新增上游
        </Button>
      </div>

      {showForm ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{editingId ? "编辑上游" : "新增上游"}</CardTitle>
            <CardDescription>
              Base URL 填 OpenAI 兼容根地址（含 /v1），例如{" "}
              <code className="font-mono text-xs">https://api.example.com/v1</code>
              ；优先级数字越小越优先，同模型多个上游时自动故障转移。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="grid gap-4" onSubmit={submit}>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="grid gap-2">
                  <Label htmlFor="upstream-name">名称</Label>
                  <Input
                    id="upstream-name"
                    required
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />
                </div>
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="upstream-url">Base URL</Label>
                  <Input
                    id="upstream-url"
                    required
                    type="url"
                    placeholder="https://api.example.com/v1"
                    value={form.baseUrl}
                    onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="upstream-key">API Key</Label>
                  <Input
                    id="upstream-key"
                    value={form.apiKey}
                    onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="upstream-priority">优先级</Label>
                  <Input
                    id="upstream-priority"
                    type="number"
                    min={0}
                    value={form.priority}
                    onChange={(event) => setForm({ ...form, priority: event.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="upstream-enabled">启用</Label>
                  <Select value={form.enabled} onValueChange={(value) => setForm({ ...form, enabled: value })}>
                    <SelectTrigger id="upstream-enabled" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">启用</SelectItem>
                      <SelectItem value="0">停用</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Label>可服务模型（{selectedModels.length}）</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={fetchingModels || !form.baseUrl}
                    onClick={fetchFormModels}
                  >
                    <RefreshCw className={fetchingModels ? "animate-spin" : undefined} />
                    {fetchingModels ? "拉取中…" : "从 /v1/models 拉取"}
                  </Button>
                  <div className="flex items-center gap-1.5">
                    <Input
                      placeholder="手动添加 model-id"
                      className="h-8 w-52 font-mono text-xs"
                      value={manualModel}
                      onChange={(event) => setManualModel(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addManualModel();
                        }
                      }}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={addManualModel} disabled={!manualModel.trim()}>
                      添加
                    </Button>
                  </div>
                </div>

                {selectedModels.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    尚未选择模型：填写 Base URL 后从上游拉取勾选，或手动添加。
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {selectedModels.map((modelId) => (
                      <Badge key={modelId} variant="secondary" className="gap-1.5 py-1 font-mono text-xs">
                        {modelId}
                        {contextLabel(modelId) ? (
                          <span className="font-sans text-[10px] text-muted-foreground">
                            {contextLabel(modelId)}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          aria-label={`移除 ${modelId}`}
                          className="rounded-sm opacity-60 transition-opacity hover:opacity-100"
                          onClick={() => toggleFormModel(modelId)}
                        >
                          <X className="size-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}

                {discoveredModels.length > 0 ? (
                  <div className="max-h-72 overflow-y-auto rounded-lg border">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-background shadow-[0_1px_0_0_var(--border)]">
                        <TableRow>
                          <TableHead className="w-10">
                            <Checkbox
                              checked={
                                allDiscoveredSelected ? true : someDiscoveredSelected ? "indeterminate" : false
                              }
                              onCheckedChange={toggleAllDiscovered}
                              aria-label="全选/取消全选"
                            />
                          </TableHead>
                          <TableHead>模型 ID</TableHead>
                          <TableHead className="text-right">Context Window</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedDiscovered.map((modelId) => (
                          <TableRow
                            key={modelId}
                            className="cursor-pointer"
                            onClick={() => toggleFormModel(modelId)}
                          >
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              <Checkbox
                                checked={selectedModels.includes(modelId)}
                                onCheckedChange={() => toggleFormModel(modelId)}
                              />
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {modelId}
                              {selectedModels.includes(modelId) ? (
                                <Badge variant="secondary" className="ml-2 font-sans text-[10px]">
                                  已选
                                </Badge>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">
                              {contextLabel(modelId) ?? "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : null}
              </div>

              {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  {editingId ? "保存" : "创建"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  取消
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">上游列表</CardTitle>
          <CardDescription>按优先级升序排列。</CardDescription>
        </CardHeader>
        <CardContent>
          {upstreams.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              还没有上游，点击「新增上游」添加第一个模型服务。
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>Base URL</TableHead>
                  <TableHead>优先级</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upstreams.map((upstream) => (
                  <TableRow key={upstream._id}>
                    <TableCell className="font-medium">{upstream.name}</TableCell>
                    <TableCell className="max-w-52 font-mono text-xs break-all">{upstream.baseUrl}</TableCell>
                    <TableCell className="tabular-nums">{upstream.priority}</TableCell>
                    <TableCell>
                      {upstream.models.length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <div className="flex max-w-72 flex-wrap items-center gap-1">
                          {upstream.models.slice(0, 3).map((modelId) => (
                            <Badge key={modelId} variant="secondary" className="font-mono text-[10px]">
                              {modelId}
                            </Badge>
                          ))}
                          {upstream.models.length > 3 ? (
                            <Badge variant="outline" className="font-mono text-[10px]">
                              +{upstream.models.length - 3}
                            </Badge>
                          ) : null}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={upstream.enabled ? "default" : "secondary"}>
                        {upstream.enabled ? "启用" : "停用"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => startEdit(upstream)}>
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={probingId === upstream._id}
                          onClick={() => probe(upstream)}
                        >
                          <Activity />
                          {probingId === upstream._id ? "探测中…" : "测试"}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          onClick={() => removeUpstream(upstream)}
                        >
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {upstreams.map((upstream) =>
            probeResults[upstream._id] ? (
              <div key={`probe-${upstream._id}`} className="mt-4 grid gap-3 rounded-lg border bg-muted/40 p-4 first:mt-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    「{upstream.name}」发现 {probeResults[upstream._id].length} 个模型
                  </p>
                  <Button
                    size="sm"
                    disabled={importingId === upstream._id}
                    onClick={() => importModels(upstream)}
                  >
                    {importingId === upstream._id ? "导入中…" : "全部导入目录（默认 1.0 倍率）"}
                  </Button>
                </div>
                <div className="max-h-28 overflow-y-auto font-mono text-xs leading-relaxed text-muted-foreground">
                  {probeResults[upstream._id].join(", ")}
                </div>
              </div>
            ) : null,
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1.5">
            <CardTitle className="text-base">模型倍率目录</CardTitle>
            <CardDescription>
              只有目录中启用且至少一个启用上游可服务的模型，才会出现在 AI API 的 /v1/models
              中。消耗额度 = ceil(tokens × 倍率)。
            </CardDescription>
          </div>
          <form className="flex items-end gap-2" onSubmit={addModel}>
            <div className="grid gap-2">
              <Input
                placeholder="model-id"
                className="w-56 font-mono text-xs"
                value={newModelId}
                onChange={(event) => setNewModelId(event.target.value)}
              />
            </div>
            <Button variant="outline" type="submit" disabled={busy || !newModelId.trim()}>
              添加模型
            </Button>
          </form>
        </CardHeader>
        <CardContent>
          {models.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              目录为空，可通过上游「测试」一键导入，或手动添加。
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型 ID</TableHead>
                  <TableHead className="w-36">上下文</TableHead>
                  <TableHead className="w-28">倍率</TableHead>
                  <TableHead className="w-32">状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((model) => {
                  const baselineContext = model.contextWindow ?? contextSizes[model._id] ?? null;
                  const edit = modelEdits[model._id] ?? {
                    rate: String(model.rate),
                    context: baselineContext ? formatContext(baselineContext) : "",
                    enabled: model.enabled,
                  };
                  const context = parseContextInput(edit.context);
                  const contextDirty = context !== (model.contextWindow ?? contextSizes[model._id] ?? null);
                  const dirty =
                    Number(edit.rate) !== model.rate ||
                    edit.enabled !== model.enabled ||
                    (context !== "invalid" && contextDirty);
                  return (
                    <TableRow key={model._id}>
                      <TableCell className="font-mono text-xs">{model._id}</TableCell>
                      <TableCell>
                        <Input
                          placeholder="272K / 1M"
                          className="font-mono text-xs uppercase"
                          value={edit.context}
                          onChange={(event) =>
                            setModelEdits((edits) => ({
                              ...edits,
                              [model._id]: { ...edit, context: event.target.value },
                            }))
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.1"
                          min={0.1}
                          value={edit.rate}
                          onChange={(event) =>
                            setModelEdits((edits) => ({
                              ...edits,
                              [model._id]: { ...edit, rate: event.target.value },
                            }))
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Select
                          value={edit.enabled ? "1" : "0"}
                          onValueChange={(value) =>
                            setModelEdits((edits) => ({
                              ...edits,
                              [model._id]: { ...edit, enabled: value === "1" },
                            }))
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">启用</SelectItem>
                            <SelectItem value="0">停用</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-2">
                          <Button size="sm" disabled={!dirty || busy} onClick={() => saveModelEdit(model)}>
                            保存
                          </Button>
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => toggleModel(model)}>
                            启停
                          </Button>
                          <Button variant="destructive" size="sm" disabled={busy} onClick={() => deleteModel(model)}>
                            删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
