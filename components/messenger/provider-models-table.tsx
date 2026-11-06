"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownToLine, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useTranslator } from "@/components/i18n/locale-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { ModelEditor, metaScheduleToDraft, type MetaDraft } from "@/components/models/model-editor";
import { providerCatalogMeta, providerModelDraft, providerDraftCapabilities, providerModelRows, applyProviderModelPatch } from "@/lib/provider-model-editor";
import type { ModelEmbed } from "@/lib/types";
import type { CatalogMetadataMap, CatalogRateMap } from "@/lib/pi-catalog";

const rateFormat = new Intl.NumberFormat("en-US", { minimumSignificantDigits: 2, maximumSignificantDigits: 2, useGrouping: false });
type Catalog = { rates: CatalogRateMap; models: CatalogMetadataMap; degraded: boolean };

export function ProviderModelsTable({ models, onChange, onFetch, fetching = false, disabled = false, readOnly = false }: {
  models: ModelEmbed[];
  onChange?: (models: ModelEmbed[]) => void;
  onFetch?: () => void;
  fetching?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const t = useTranslator();
  const router = useRouter();
  const [catalog, setCatalog] = useState<Catalog>({ rates: {}, models: {}, degraded: false });
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const loaded = Object.keys(catalog.rates).length > 0 || Object.keys(catalog.models).length > 0;
  const [query, setQuery] = useState("");
  const [onlyUnconfigured, setOnlyUnconfigured] = useState(false);
  const [manualModel, setManualModel] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<string[]>([]);
  const [editing, setEditing] = useState<string[]>([]);
  const [patch, setPatch] = useState<Partial<MetaDraft>>({});
  const revision = useRef(0);
  useEffect(() => {
    if (readOnly) return;
    const controller = new AbortController();
    const request = ++revision.current;
    // Keep existing catalog data while reloading, without changing any Provider draft.
    void (async () => {
      setCatalogBusy(true);
      setCatalogError(null);
      try {
        const response = await fetch(`/api/models/catalog${refresh ? "?refresh=1" : ""}`, { signal: controller.signal });
        if (response.status === 401) router.replace("/login");
        if (!response.ok) throw new Error(t("元数据拉取失败，请稍后重试。"));
        const result = await response.json() as Catalog;
        if (!controller.signal.aborted && revision.current === request) setCatalog(result);
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : t("元数据拉取失败，请稍后重试。");
          setCatalogError(message);
          toast.error(message);
        }
      } finally {
        if (!controller.signal.aborted && revision.current === request) setCatalogBusy(false);
      }
    })();
    return () => controller.abort();
  }, [refresh, readOnly, router, t]);

  const catalogMeta = useMemo(() => providerCatalogMeta(catalog.rates), [catalog.rates]);
  const rows = useMemo(() => providerModelRows(models, catalog.rates, catalog.models, loaded), [models, catalog, loaded]);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = models.filter((model) => (!onlyUnconfigured || rows.get(model.id)?.unconfigured)
    && terms.every((term) => `${model.modelId} ${rows.get(model.id)?.displayName}`.toLowerCase().includes(term)));
  const visibleChecked = visible.filter((model) => checked.includes(model.id));
  const hiddenCount = models.filter((model) => checked.includes(model.id)).length - visibleChecked.length;
  const unconfigured = models.filter((model) => rows.get(model.id)?.unconfigured).length;
  const busy = disabled || fetching;
  const editingModel = models.find((model) => model.id === editing[0]);
  const draft = editingModel ? { ...providerModelDraft(editingModel), ...patch } : {};
  const inherited = editingModel ? providerModelRows([{ ...editingModel, displayName: "", contextWindow: null, metadata: null,
    inputRate: null, cacheReadRate: null, cacheWriteRate: null, outputRate: null, tiers: null, timeBased: null,
    catalogModelId: draft.catalogModelId || null }], catalog.rates, catalog.models, loaded).get(editingModel.id)?.card : undefined;

  function addModel() {
    const modelId = manualModel.trim();
    if (!modelId || models.some((model) => model.modelId === modelId)) return;
    onChange?.([...models, { id: crypto.randomUUID(), modelId, displayName: "", isEnabled: true, createdAt: Date.now() }]);
    setManualModel("");
    setQuery("");
    setOnlyUnconfigured(false);
  }

  function finishEdit() {
    if (busy || readOnly) return;
    try {
      const updated = models.map((model) => editing.includes(model.id) ? applyProviderModelPatch(model, patch, t) : model);
      onChange?.(updated);
      setEditing([]);
      setPatch({});
    } catch (error) { toast.error(error instanceof Error ? error.message : t("请填写有效的模型元数据和非负倍率。")); }
  }

  function startEdit(ids: string[]) { setEditing(ids); setPatch({}); }
  function setEnabled(ids: string[], enabled: boolean) { onChange?.(models.map((model) => ids.includes(model.id) ? { ...model, isEnabled: enabled } : model)); }

  return (
    <div className="grid min-w-0 gap-3">
      {!readOnly ? <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onFetch} disabled={busy}><RefreshCw className={fetching ? "animate-spin" : undefined} />{fetching ? t("拉取中…") : t("拉取模型")}</Button>
        <Input className="h-8 min-w-32 flex-1" value={manualModel} onChange={(event) => setManualModel(event.target.value)} placeholder={t("手动添加 model-id")} aria-label={t("模型 ID")} disabled={busy} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addModel(); } }} />
        <Button type="button" variant="outline" size="sm" onClick={addModel} disabled={busy || !manualModel.trim()}><Plus />{t("添加")}</Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)} disabled={busy || catalogBusy}><ArrowDownToLine className={catalogBusy ? "animate-spin" : undefined} />{t("更新元数据")}</Button>
      </div> : null}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索模型 ID 或显示名…")} aria-label={t("搜索模型 ID 或显示名")} />
        {!readOnly ? <Button type="button" variant={onlyUnconfigured ? "secondary" : "outline"} onClick={() => setOnlyUnconfigured((value) => !value)} disabled={!loaded}>{t("仅看未配置（")}{unconfigured}）</Button> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{t("显示")}{" "}{visible.length} / {models.length}</span>
        {query || onlyUnconfigured ? <Button type="button" variant="ghost" size="sm" onClick={() => { setQuery(""); setOnlyUnconfigured(false); }}>{t("清除筛选")}</Button> : null}
        {catalogBusy ? <span role="status">{t("正在读取模型 metadata…")}</span> : null}
      </div>
      {catalogError ? <p role="alert" className="text-xs text-destructive">{catalogError}</p> : null}
      {catalog.degraded ? <p className="text-xs text-muted-foreground">{t("模型目录暂不可用，能力信息可能来自旧快照或暂时缺失。")}</p> : null}
      {!readOnly && (visibleChecked.length || hiddenCount) ? <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("当前结果已选")}{" "}{visibleChecked.length}</span>
        {hiddenCount ? <span className="text-xs text-muted-foreground">{t("筛选外已选")}{" "}{hiddenCount}{t("（不参与本次批量操作）")}</span> : null}
        <Button type="button" variant="outline" size="sm" disabled={busy || !visibleChecked.length} onClick={() => setEnabled(visibleChecked.map((model) => model.id), true)}>{t("批量启用")}</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy || !visibleChecked.length} onClick={() => setEnabled(visibleChecked.map((model) => model.id), false)}>{t("批量停用")}</Button>
        <Button type="button" variant="outline" size="sm" disabled={busy || !visibleChecked.length} onClick={() => startEdit(visibleChecked.map((model) => model.id))}>{t("批量编辑")}</Button>
        <Button type="button" variant="destructive" size="sm" disabled={busy || !visibleChecked.length} onClick={() => setPendingDelete(visibleChecked.map((model) => model.id))}>{t("批量删除")}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setChecked([])}>{t("取消选择")}</Button>
      </div> : null}
      <div className="min-w-0 rounded-lg border">
        <ScrollArea className="min-w-0 [&_[data-slot=table-container]]:overflow-visible [&_[data-slot=scroll-area-viewport]>div]:!block">
          <Table className="min-w-[46rem]">
            <TableHeader><TableRow>
              {!readOnly ? <TableHead className="w-10"><Checkbox aria-label={t("全选当前筛选结果用于批量操作")} disabled={busy || !visible.length} checked={visible.length > 0 && visibleChecked.length === visible.length ? true : visibleChecked.length ? "indeterminate" : false} onCheckedChange={(value) => setChecked((current) => value === true ? [...new Set([...current, ...visible.map((model) => model.id)])] : current.filter((id) => !visible.some((model) => model.id === id)))} /></TableHead> : null}
              <TableHead>{t("模型 ID")}</TableHead><TableHead>{t("显示名")}</TableHead><TableHead>{t("当前倍率")}</TableHead><TableHead className="text-right">{t("操作")}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {!visible.length ? <TableRow><TableCell colSpan={readOnly ? 4 : 5} className="py-8 text-center text-muted-foreground">{t("没有匹配的模型，请调整搜索或筛选条件。")}</TableCell></TableRow> : null}
              {visible.map((model) => {
                const row = rows.get(model.id)!;
                return <TableRow key={model.id} data-state={checked.includes(model.id) ? "selected" : undefined}>
                  {!readOnly ? <TableCell><Checkbox aria-label={t("选择模型 {0}", { "0": model.modelId })} disabled={busy} checked={checked.includes(model.id)} onCheckedChange={(value) => setChecked((current) => value === true ? [...new Set([...current, model.id])] : current.filter((id) => id !== model.id))} /></TableCell> : null}
                  <TableCell className="font-mono text-xs">{model.modelId}{row.unconfigured ? <Badge variant="outline" className="ml-2 border-orange-500/40 bg-orange-500/10 font-sans text-[10px] text-orange-700 dark:text-orange-300">{t("未配置")}</Badge> : null}{!model.isEnabled ? <Badge variant="secondary" className="ml-2 font-sans text-[10px]">{t("已停用")}</Badge> : null}</TableCell>
                  <TableCell className="max-w-56 text-sm"><span className="block truncate" title={row.displayName}>{row.displayName}</span></TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums" title={t("四腿顺序：输入 / 缓存读取 / 缓存写入 / 输出{0}", { "0": "" })}>
                    {[row.card.input, row.card.cacheRead, row.card.cacheWrite, row.card.output].map((value) => rateFormat.format(value)).join(" / ")}
                    {row.card.tiers?.length ? <span className="ml-1 font-sans text-[10px] text-muted-foreground">{t("阶梯×{0}", { "0": row.card.tiers.length })}</span> : null}
                    {row.card.timeBased ? <span className="ml-1 font-sans text-[10px] text-muted-foreground">{t("峰谷×{0}", { "0": row.card.timeBased.offPeakMultiplier })}</span> : null}
                  </TableCell>
                  <TableCell><div className="flex justify-end gap-1.5">
                    {readOnly ? <Badge variant="secondary">{t("可用")}</Badge> : <><Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => startEdit([model.id])}>{t("编辑")}</Button><Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => setEnabled([model.id], !model.isEnabled)}>{model.isEnabled ? t("停用") : t("启用")}</Button><Button type="button" variant="ghost" size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => setPendingDelete([model.id])}>{t("删除")}</Button></>}
                  </div></TableCell>
                </TableRow>;
              })}
            </TableBody>
          </Table><ScrollBar orientation="horizontal" />
        </ScrollArea>
      </div>
      {!readOnly ? <p className="text-xs text-muted-foreground">{t("模型信息留空时自动匹配 catalog；远端返回值和自定义值优先。保存 Provider 后生效。")}</p> : null}
      {editingModel && inherited ? <ModelEditor key={editingModel.id} modelId={editingModel.modelId} title={editing.length > 1 ? t("批量编辑 {0} 个模型", { "0": editing.length }) : undefined} description={editing.length > 1 ? t("仅将修改过的字段应用到所选模型，其余字段保持各自原值。") : undefined} open catalogModelId={draft.catalogModelId ?? ""} catalog={catalogMeta} catalogCapabilities={catalog.models} capabilities={providerDraftCapabilities(draft)}
        rates={{ inputRate: draft.inputRate ?? "", cacheReadRate: draft.cacheReadRate ?? "", cacheWriteRate: draft.cacheWriteRate ?? "", outputRate: draft.outputRate ?? "" }} multiplier="" showMultiplier={false}
        tiers={draft.tiers ?? []} schedule={draft.timeBased ?? metaScheduleToDraft(undefined)} inheritedRates={{ inputRate: inherited.input, cacheReadRate: inherited.cacheRead, cacheWriteRate: inherited.cacheWrite, outputRate: inherited.output }}
        inheritedTiers={providerCatalogMeta({ inherited }).inherited.tiers} inheritedSchedule={inherited.timeBased}
        onChange={(next) => setPatch((current) => ({ ...current, ...next }))} onClose={finishEdit} onCancel={() => { setEditing([]); setPatch({}); }} /> : null}
      <AlertDialog open={pendingDelete.length > 0} onOpenChange={(open) => { if (!open) setPendingDelete([]); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t("删除 {0} 个模型？", { "0": pendingDelete.length })}</AlertDialogTitle><AlertDialogDescription>{t("将移除所选模型及其元数据和倍率，保存 Provider 后生效。")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{t("取消")}</AlertDialogCancel><AlertDialogAction onClick={() => { onChange?.(models.filter((model) => !pendingDelete.includes(model.id))); setChecked((current) => current.filter((id) => !pendingDelete.includes(id))); setPendingDelete([]); }}>{t("删除")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  );
}
