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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, ArrowDownToLine, Plus, RefreshCw, X } from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import type { UpstreamDoc, UpstreamModelMeta } from "@/lib/types";

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

type DevMeta = Record<string, UpstreamModelMeta>;
interface MetaDraft {
  context: string;
  inputRate: string;
  outputRate: string;
}

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

/** 上下文编辑：接受 272K / 1M / 200000（不区分大小写，最多两位小数），空串 = 0（不限）。 */
function parseContextInput(input: string): number | "invalid" {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) {
    return 0;
  }
  const match = /^([0-9]+(\.[0-9]{1,2})?)\s*(K|M)?$/.exec(trimmed);
  if (!match) {
    return "invalid";
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    return "invalid";
  }
  return Math.round(value * (match[3] === "K" ? 1_000 : match[3] === "M" ? 1_000_000 : 1));
}

/** 倍率编辑：非负数字，空串 = 0（不计费）。 */
function parseRateInput(input: string): number | "invalid" {
  const trimmed = input.trim();
  if (!trimmed) {
    return 0;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

export function UpstreamsManager({ upstreams }: { upstreams: UpstreamDoc[] }) {
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

  const [devMeta, setDevMeta] = useState<DevMeta>({});
  const [editingModelMeta, setEditingModelMeta] = useState<Record<string, UpstreamModelMeta>>({});
  const [metaDrafts, setMetaDrafts] = useState<Record<string, MetaDraft>>({});
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, boolean>>({});
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, string[]>>({});

  // models.dev 元数据（含上下文与归一化倍率），页面加载时拉取一次。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/admin/models/metadata");
        if (!response.ok) return;
        const payload = (await response.json()) as {
          metadata?: Record<string, UpstreamModelMeta>;
        };
        if (!cancelled && payload.metadata) {
          setDevMeta(payload.metadata);
        }
      } catch {
        // 元数据仅用于展示/默认值，拉取失败静默降级（显示 0 = 不限制）。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function startCreate() {
    setEditingId(null);
    setForm(emptyUpstreamForm);
    setSelectedModels([]);
    setDiscoveredModels([]);
    setManualModel("");
    setEditingModelMeta({});
    setMetaDrafts({});
    setOverrideDrafts({});
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
    setEditingModelMeta(upstream.modelMeta ?? {});
    setMetaDrafts({});
    setOverrideDrafts({});
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
    setDiscoveredModels((models) =>
      models.includes(modelId) ? models : [...models, modelId].sort((a, b) => a.localeCompare(b)),
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
        contextSizes?: Record<string, number>;
        error?: string;
      } | null;
      if (!response.ok || !payload?.models) {
        setFormError(payload?.error ?? "拉取失败，请稍后重试。");
        return;
      }
      if (payload.contextSizes) {
        setDevMeta((meta) => {
          const next = { ...meta };
          for (const [modelId, contextWindow] of Object.entries(payload.contextSizes ?? {})) {
            next[modelId] = { ...next[modelId], contextWindow };
          }
          return next;
        });
      }
      setDiscoveredModels((models) =>
        [...new Set([...models, ...payload.models ?? []])].sort((a, b) => a.localeCompare(b)),
      );
      toast.success(`发现 ${payload.models.length} 个模型，勾选后保存即可`);
    } catch {
      setFormError("网络错误，请稍后重试。");
    } finally {
      setFetchingModels(false);
    }
  }

  /** 从 models.dev 更新元数据：强制刷新服务端 24h 缓存并更新本页显示，
   *  不改变任何模型的覆盖开关。 */
  async function updateMetaFromModelsDev() {
    setFormError(null);
    try {
      const response = await fetch("/api/admin/models/metadata?refresh=1");
      if (!response.ok) {
        setFormError("元数据拉取失败，请稍后重试。");
        return;
      }
      const payload = (await response.json()) as {
        metadata?: Record<string, UpstreamModelMeta>;
      };
      const metadata = payload.metadata ?? {};
      if (Object.keys(metadata).length === 0) {
        toast.error("models.dev 无可用元数据（服务器可能无法访问 models.dev）");
        return;
      }
      setDevMeta((meta) => ({ ...meta, ...metadata }));
      toast.success(`已从 models.dev 更新 ${Object.keys(metadata).length} 个模型的元数据`);
    } catch {
      setFormError("网络错误，请稍后重试。");
    }
  }

  function metaDraftOf(modelId: string): MetaDraft {
    return (
      metaDrafts[modelId] ?? {
        context: "",
        inputRate: "",
        outputRate: "",
      }
    );
  }

  /** 按模型覆盖开关：行草稿 > 已存自定义 > 默认关闭（用 models.dev）。 */
  function rowOverride(modelId: string): boolean {
    return overrideDrafts[modelId] ?? editingModelMeta[modelId]?.override ?? false;
  }

  function setRowOverride(modelId: string, override: boolean) {
    setOverrideDrafts((drafts) => ({ ...drafts, [modelId]: override }));
  }

  /** 生效元数据（按模型）：覆盖开启时 草稿 > 自定义 > models.dev > 0；
   *  关闭时 models.dev > 0。 */
  function resolvedMeta(modelId: string): { contextWindow: number; inputRate: number; outputRate: number } {
    const dev = devMeta[modelId];
    if (!rowOverride(modelId)) {
      return { contextWindow: dev?.contextWindow ?? 0, inputRate: dev?.inputRate ?? 0, outputRate: dev?.outputRate ?? 0 };
    }
    const stored = editingModelMeta[modelId];
    const draft = metaDrafts[modelId];
    const pick = (
      draftValue: string | undefined,
      storedValue: number | null | undefined,
      devValue: number | null | undefined,
    ): number => {
      if (draftValue !== undefined) {
        const parsed = parseContextInput(draftValue);
        return parsed === "invalid" ? (storedValue ?? devValue ?? 0) : parsed;
      }
      return storedValue ?? devValue ?? 0;
    };
    const pickRate = (
      draftValue: string | undefined,
      storedValue: number | null | undefined,
      devValue: number | null | undefined,
    ): number => {
      if (draftValue !== undefined) {
        const parsed = parseRateInput(draftValue);
        return parsed === "invalid" ? (storedValue ?? devValue ?? 0) : parsed;
      }
      return storedValue ?? devValue ?? 0;
    };
    return {
      contextWindow: pick(draft?.context, stored?.contextWindow, dev?.contextWindow),
      inputRate: pickRate(draft?.inputRate, stored?.inputRate, dev?.inputRate),
      outputRate: pickRate(draft?.outputRate, stored?.outputRate, dev?.outputRate),
    };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // 草稿格式校验：无效输入阻止提交。
    for (const [modelId, draft] of Object.entries(metaDrafts)) {
      if (parseContextInput(draft.context) === "invalid") {
        setFormError(`模型 ${modelId} 的上下文格式无效，请使用 272K / 1M 等形式。`);
        return;
      }
      if (parseRateInput(draft.inputRate) === "invalid" || parseRateInput(draft.outputRate) === "invalid") {
        setFormError(`模型 ${modelId} 的倍率必须是数字。`);
        return;
      }
    }
    const modelMeta: Record<string, UpstreamModelMeta> = {};
    for (const modelId of discoveredModels) {
      if (overrideDrafts[modelId] === undefined && editingModelMeta[modelId] === undefined) {
        continue;
      }
      if (!rowOverride(modelId)) {
        modelMeta[modelId] = { override: false };
        continue;
      }
      const resolved = resolvedMeta(modelId);
      modelMeta[modelId] = {
        override: true,
        contextWindow: resolved.contextWindow,
        inputRate: resolved.inputRate,
        outputRate: resolved.outputRate,
      };
    }
    const payload: Record<string, unknown> = {
      name: form.name,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
      models: selectedModels,
      priority: Number(form.priority) || 0,
      enabled: form.enabled === "1",
    };
    if (Object.keys(modelMeta).length > 0) {
      payload.modelMeta = modelMeta;
    }
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

  /** 只读展示（覆盖关闭或未编辑时）的上下文/倍率文本。 */
  function contextDisplay(modelId: string): string {
    const meta = resolvedMeta(modelId);
    return meta.contextWindow > 0 ? formatContext(meta.contextWindow) : "不限";
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
              </div>

              <Separator />

              <div className="grid gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    每个模型的元数据默认取自 models.dev（上下文 0 = 不限制，倍率 0 = 不计费）；
                    在表格中打开「覆盖」后可为此上游单独自定义。
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={updateMetaFromModelsDev}>
                    <ArrowDownToLine />
                    从 models.dev 更新元数据
                  </Button>
                </div>

                {discoveredModels.length > 0 ? (
                  <div className="overflow-hidden rounded-lg border">
                    <Table>
                      <TableHeader>
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
                          <TableHead className="w-16">覆盖</TableHead>
                          <TableHead className="w-36">Context Window</TableHead>
                          <TableHead className="w-24">输入倍率</TableHead>
                          <TableHead className="w-24">输出倍率</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sortedDiscovered.map((modelId) => {
                          const meta = resolvedMeta(modelId);
                          const editable = rowOverride(modelId);
                          const draft = metaDraftOf(modelId);
                          const setDraft = (field: keyof MetaDraft, value: string) =>
                            setMetaDrafts((drafts) => ({
                              ...drafts,
                              [modelId]: { ...metaDraftOf(modelId), [field]: value },
                            }));
                          return (
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
                              <TableCell onClick={(event) => event.stopPropagation()}>
                                <Switch
                                  checked={rowOverride(modelId)}
                                  onCheckedChange={(checked) => setRowOverride(modelId, checked)}
                                  aria-label={"覆盖 " + modelId}
                                />
                              </TableCell>
                              <TableCell onClick={(event) => event.stopPropagation()}>
                                {editable ? (
                                  <Input
                                    placeholder="272K / 1M"
                                    className="h-8 font-mono text-xs uppercase"
                                    value={draft.context}
                                    onChange={(event) => setDraft("context", event.target.value)}
                                  />
                                ) : (
                                  <span className="font-mono text-xs text-muted-foreground">
                                    {contextDisplay(modelId)}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell onClick={(event) => event.stopPropagation()}>
                                {editable ? (
                                  <Input
                                    inputMode="decimal"
                                    className="h-8 font-mono text-xs tabular-nums"
                                    value={draft.inputRate}
                                    onChange={(event) => setDraft("inputRate", event.target.value)}
                                  />
                                ) : (
                                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                                    {meta.inputRate}
                                  </span>
                                )}
                              </TableCell>
                              <TableCell onClick={(event) => event.stopPropagation()}>
                                {editable ? (
                                  <Input
                                    inputMode="decimal"
                                    className="h-8 font-mono text-xs tabular-nums"
                                    value={draft.outputRate}
                                    onChange={(event) => setDraft("outputRate", event.target.value)}
                                  />
                                ) : (
                                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                                    {meta.outputRate}
                                  </span>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
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
                  <TableHead>元数据</TableHead>
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
                      {(() => {
                        const overrideCount = Object.values(upstream.modelMeta ?? {}).filter(
                          (meta) => meta.override,
                        ).length;
                        return (
                          <Badge variant={overrideCount > 0 ? "default" : "secondary"}>
                            {overrideCount > 0 ? overrideCount + " 项覆盖" : "models.dev"}
                          </Badge>
                        );
                      })()}
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
                <p className="text-sm font-medium">「{upstream.name}」发现 {probeResults[upstream._id].length} 个模型</p>
                <div className="max-h-28 overflow-y-auto font-mono text-xs leading-relaxed text-muted-foreground">
                  {probeResults[upstream._id].join(", ")}
                </div>
              </div>
            ) : null,
          )}
        </CardContent>
      </Card>
    </div>
  );
}
