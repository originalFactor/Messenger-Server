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
import { Activity, Plus } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import type { AiModelDoc, UpstreamDoc } from "@/lib/types";

interface UpstreamFormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string;
  priority: string;
  enabled: string;
}

const emptyUpstreamForm: UpstreamFormState = {
  name: "",
  baseUrl: "",
  apiKey: "",
  models: "",
  priority: "0",
  enabled: "1",
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
      enabled: upstream.enabled ? "1" : "0",
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
      enabled: form.enabled === "1",
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
                <div className="grid gap-2 sm:col-span-2 lg:col-span-3">
                  <Label htmlFor="upstream-models">可服务模型（每行一个，或逗号分隔）</Label>
                  <Textarea
                    id="upstream-models"
                    className="font-mono text-xs"
                    placeholder={"gpt-4o\ndeepseek-chat"}
                    value={form.models}
                    onChange={(event) => setForm({ ...form, models: event.target.value })}
                  />
                </div>
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
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
                  <TableHead>模型数</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upstreams.map((upstream) => (
                  <TableRow key={upstream._id}>
                    <TableCell className="font-medium">{upstream.name}</TableCell>
                    <TableCell className="max-w-64 font-mono text-xs break-all">{upstream.baseUrl}</TableCell>
                    <TableCell className="tabular-nums">{upstream.priority}</TableCell>
                    <TableCell className="tabular-nums">{upstream.models.length}</TableCell>
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
                  <TableHead className="w-32">倍率</TableHead>
                  <TableHead className="w-32">状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((model) => {
                  const edit = modelEdits[model._id] ?? { rate: String(model.rate), enabled: model.enabled };
                  const dirty = Number(edit.rate) !== model.rate || edit.enabled !== model.enabled;
                  return (
                    <TableRow key={model._id}>
                      <TableCell className="font-mono text-xs">{model._id}</TableCell>
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
