"use client";

import { useTranslator } from "@/components/i18n/locale-provider";
import { useMemo, useState } from "react";
import { ChevronsUpDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatPeakWindows } from "@/lib/pricing";
import { rankCatalogModels } from "@/lib/model-rates";
import type { UpstreamModelMeta } from "@/lib/types";
import type { CatalogMetadataMap } from "@/lib/pi-catalog";
import { resolveModelCapabilities } from "@/lib/model-capabilities";

export type CatalogMeta = Record<string, UpstreamModelMeta>;

export const CAPABILITY_FIELDS = [
  { key: "displayName", label: "显示名", kind: "text" },
  { key: "inputModalities", label: "输入模态", kind: "list" },
  { key: "reasoning", label: "是否支持思考", kind: "boolean" },
  { key: "reasoningEfforts", label: "Reasoning efforts", kind: "list" },
  { key: "contextWindow", label: "上下文窗口", kind: "number" },
  { key: "maxOutputTokens", label: "最大输出 tokens", kind: "number" },
  { key: "supportsTemperature", label: "支持 temperature", kind: "boolean" },
  { key: "supportsTopP", label: "支持 top_p", kind: "boolean" },
  { key: "supportsPenalties", label: "支持 penalties", kind: "boolean" },
] as const;

export type CapabilityKey = (typeof CAPABILITY_FIELDS)[number]["key"];

export function CapabilityMultiSelect({ id, value, inherited, options, onChange }: {
  id: string;
  value: string;
  inherited: string[];
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  const t = useTranslator();
  const custom = value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
  const selected = custom.length ? custom : inherited;
  const choices = [...new Set([...options, ...inherited, ...custom])];
  const summary = selected.length ? selected.join(", ") : t("未提供");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button id={id} type="button" variant="outline" className="w-full min-w-0 justify-between font-normal">
          <span className="truncate">{custom.length ? summary : t("继承（{0}）", { "0": summary })}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onChange("")}>{t("恢复继承 catalog")}</DropdownMenuItem>
        <DropdownMenuSeparator />
        {choices.map((option) => (
          <DropdownMenuCheckboxItem key={option} checked={selected.includes(option)} onSelect={(event) => event.preventDefault()} onCheckedChange={(checked) => {
            const next = checked ? [...new Set([...selected, option])] : selected.filter((item) => item !== option);
            onChange(next.join(", "));
          }}>{option}</DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface MetaDraft extends Partial<Record<CapabilityKey, string>> {
  /** 空串 = 恢复自动匹配，undefined = 未修改。 */
  catalogModelId?: string;
  inputRate?: string;
  cacheReadRate?: string;
  cacheWriteRate?: string;
  outputRate?: string;
  /** 模型整体倍率（modelRate）草稿；空串 = 1。 */
  multiplier?: string;
  /** 长上下文阶梯草稿（整份覆盖）；undefined = 未动，沿用上游/目录。 */
  tiers?: TierDraft[];
  /** 峰谷草稿（整份覆盖）；undefined = 未动，沿用上游/目录。 */
  timeBased?: ScheduleDraft;
}

export interface TierDraft {
  inputThreshold: string;
  inputRate: string;
  cacheReadRate: string;
  cacheWriteRate: string;
  outputRate: string;
}

export interface ScheduleDraft {
  offPeakMultiplier: string;
  peakWindows: string;
}

export function emptyTierDraft(): TierDraft {
  return { inputThreshold: "", inputRate: "", cacheReadRate: "", cacheWriteRate: "", outputRate: "" };
}

export function metaScheduleToDraft(schedule: UpstreamModelMeta["timeBased"] | undefined): ScheduleDraft {
  return {
    offPeakMultiplier: schedule ? String(schedule.offPeakMultiplier) : "1",
    peakWindows: schedule ? formatPeakWindows(schedule) : "",
  };
}

export function ModelEditor({
  modelId,
  title,
  description,
  onCancel,
  catalogModelId,
  catalog,
  catalogCapabilities,
  capabilities,
  open,
  rates,
  multiplier,
  showMultiplier = true,
  tiers,
  schedule,
  inheritedTiers,
  inheritedSchedule,
  inheritedRates,
  onChange,
  onClose,
}: {
  modelId: string;
  title?: string;
  description?: string;
  onCancel?: () => void;
  catalogModelId: string;
  catalog: CatalogMeta;
  catalogCapabilities: CatalogMetadataMap;
  capabilities: Record<CapabilityKey, string>;
  open: boolean;
  rates: { inputRate: string; cacheReadRate: string; cacheWriteRate: string; outputRate: string };
  multiplier: string;
  showMultiplier?: boolean;
  tiers: TierDraft[];
  schedule: ScheduleDraft;
  inheritedTiers: UpstreamModelMeta["tiers"];
  inheritedSchedule: UpstreamModelMeta["timeBased"];
  /** 未覆盖时表格里展示的基础倍率（只读提示）。 */
  inheritedRates: { inputRate: number; cacheReadRate: number; cacheWriteRate: number; outputRate: number };
  onChange: (patch: Partial<MetaDraft>) => void;
  onClose: () => void;
}) {
  const t = useTranslator();
  const [choosingCatalog, setChoosingCatalog] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogLimit, setCatalogLimit] = useState(50);
  const catalogResults = useMemo(
    () => choosingCatalog ? rankCatalogModels(modelId, Object.keys({ ...catalog, ...catalogCapabilities }), catalogSearch) : [],
    [choosingCatalog, modelId, catalog, catalogCapabilities, catalogSearch],
  );
  const setTier = (index: number, patch: Partial<TierDraft>) =>
    onChange({ tiers: tiers.map((tier, position) => (position === index ? { ...tier, ...patch } : tier)) });
  const inheritedTierText = (inheritedTiers ?? [])
    .map((tier) => `>${tier.inputThreshold} tokens`)
    .join("、");
  const inheritedCapabilities = resolveModelCapabilities(modelId, catalogCapabilities, { catalogModelId });
  const setRate = (field: keyof typeof rates, value: string) => onChange({ [field]: value });
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : (onCancel ?? onClose)())}>
      <DialogContent className="flex h-[calc(100dvh-6rem)] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle className="break-all font-mono text-base">{title ?? modelId}</DialogTitle>
          <DialogDescription>
            {" "}{description ?? t("倍率逐项留空即沿用上游 `/v1/models` 报价或 catalog，0 表示免费。模型能力留空时继承 catalog。")}{" "}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea type="always" className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=table-container]]:overflow-visible">
        <div className="grid min-w-0 gap-4 pr-3 pb-2">
          <div className="grid min-w-0 gap-2 rounded-lg border p-3">
            <Label htmlFor="catalog-model-target" className="text-xs">{t("pi-catalog 目标模型")}</Label>
            <Popover
              modal
              open={choosingCatalog}
              onOpenChange={(next) => {
                setChoosingCatalog(next);
                if (next) {
                  setCatalogSearch("");
                  setCatalogLimit(50);
                }
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  id="catalog-model-target"
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={choosingCatalog}
                  className="w-full min-w-0 justify-between font-mono text-xs"
                >
                  <span className="truncate">{catalogModelId || t("自动匹配")}</span>
                  <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
                <Command shouldFilter={false}>
                  <CommandInput
                    aria-label={t("搜索 pi-catalog 模型")}
                    placeholder={t("搜索模型 ID 或供应商…")}
                    value={catalogSearch}
                    onValueChange={(value) => {
                      setCatalogSearch(value);
                      setCatalogLimit(50);
                    }}
                  />
                  <CommandList className="max-h-64">
                    <CommandGroup>
                      <CommandItem
                        value="__auto__"
                        data-checked={!catalogModelId}
                        onSelect={() => {
                          onChange({ catalogModelId: "" });
                          setChoosingCatalog(false);
                        }}
                      >
                        {" "}{t("自动匹配（恢复默认）")}{" "}
                      </CommandItem>
                    </CommandGroup>
                    <CommandGroup heading={t("{0} 个结果 · 按匹配度排序", { "0": catalogResults.length })}>
                      {catalogResults.slice(0, catalogLimit).map((id) => (
                        <CommandItem
                          key={id}
                          value={id}
                          data-checked={id === catalogModelId}
                          className="font-mono text-xs"
                          onSelect={() => {
                            onChange({ catalogModelId: id });
                            setChoosingCatalog(false);
                          }}
                        >
                          <span className="min-w-0 break-all">{id}</span>
                        </CommandItem>
                      ))}
                      {catalogResults.length > catalogLimit ? (
                        <CommandItem value="__more__" onSelect={() => setCatalogLimit((limit) => limit + 50)}>
                          {" "}{t("显示更多")}{" "}
                        </CommandItem>
                      ) : null}
                    </CommandGroup>
                    {catalogResults.length === 0 ? (
                      <p className="p-3 text-xs text-muted-foreground" role="status">
                        {Object.keys(catalog).length === 0 ? t("目录尚未加载，请先更新元数据。") : t("没有找到匹配的模型。")}
                      </p>
                    ) : null}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {catalogModelId && !Object.hasOwn(catalog, catalogModelId) && !Object.hasOwn(catalogCapabilities, catalogModelId) ? (
              <p className="text-xs text-destructive">{t("当前目录中未找到此目标，请更新元数据或重新选择。")}</p>
            ) : null}
            <p className="text-[10px] text-muted-foreground">
              {" "}{t("用于默认倍率、长上下文阶梯和峰谷配置；自定义覆盖和上游报价仍优先。修改后需保存上游。")}{" "}
            </p>
          </div>

          <div className="grid gap-3 rounded-lg border p-3">
            <div><Label>{t("模型元数据")}</Label><p className="text-xs text-muted-foreground">{t("留空或选择“继承”时使用 catalog；temperature / top_p / penalties 缺省开启。")}</p></div>
            <div className="grid gap-3 sm:grid-cols-2">
              {CAPABILITY_FIELDS.map((field) => {
                const inherited = inheritedCapabilities[field.key];
                const hint = Array.isArray(inherited) ? inherited.join(", ") : inherited == null ? t("未提供") : String(inherited);
                return (
                  <div key={field.key} className="grid gap-1">
                    <Label htmlFor={`model-cap-${field.key}`}>{t(field.label)}</Label>
                    {field.kind === "boolean" ? (
                      <Select value={capabilities[field.key] || "inherit"} onValueChange={(value) => onChange({ [field.key]: value === "inherit" ? "" : value })}>
                        <SelectTrigger id={`model-cap-${field.key}`} className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="inherit">{t("继承（")}{inherited === true ? t("开启") : inherited === false ? t("关闭") : t("未知")}）</SelectItem><SelectItem value="true">{t("开启")}</SelectItem><SelectItem value="false">{t("关闭")}</SelectItem></SelectContent>
                      </Select>
                    ) : field.kind === "list" ? (
                      <CapabilityMultiSelect id={`model-cap-${field.key}`} value={capabilities[field.key]} inherited={Array.isArray(inherited) ? inherited : []} options={field.key === "inputModalities" ? ["text", "image", "audio", "video", "file"] : ["none", "minimal", "low", "medium", "high", "xhigh", "max"]} onChange={(value) => onChange({ [field.key]: value })} />
                    ) : <Input id={`model-cap-${field.key}`} type={field.kind === "number" ? "number" : "text"} min={field.kind === "number" ? 1 : undefined} step={field.kind === "number" ? 1 : undefined} value={capabilities[field.key]} placeholder={hint} onChange={(event) => onChange({ [field.key]: event.target.value })} />}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ["inputRate", t("输入倍率")],
                ["cacheReadRate", t("缓存读取倍率")],
                ["cacheWriteRate", t("缓存写入倍率")],
                ["outputRate", t("输出倍率")],
              ] as const
            ).map(([field, label]) => (
              <div key={field} className="grid gap-1">
                <Label htmlFor={`model-${field}-${modelId}`} className="text-[10px]">
                  {label}
                </Label>
                <Input
                  id={`model-${field}-${modelId}`}
                  inputMode="decimal"
                  className="h-8 font-mono text-xs tabular-nums"
                  placeholder={String(inheritedRates[field])}
                  value={rates[field]}
                  onChange={(event) => setRate(field, event.target.value)}
                />
              </div>
            ))}
          </div>

          {showMultiplier ? <div className="grid gap-1 sm:w-40">
            <Label htmlFor={`model-multiplier-${modelId}`} className="text-[10px]">
              {" "}{t("模型整体倍率（缺省 = 1）")}{" "}
            </Label>
            <Input
              id={`model-multiplier-${modelId}`}
              inputMode="decimal"
              className="h-8 font-mono text-xs tabular-nums"
              placeholder="1"
              value={multiplier}
              onChange={(event) => onChange({ multiplier: event.target.value })}
            />
          </div> : null}

          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs">{t("长上下文阶梯")}</Label>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">
                  {inheritedTierText ? t("当前继承：{0}", { "0": inheritedTierText }) : t("当前无阶梯")}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => onChange({ tiers: [...tiers, emptyTierDraft()] })}
                >
                  <Plus />
                  {" "}{t("添加档位")}{" "}
                </Button>
              </div>
            </div>
            {tiers.length === 0 ? (
              <p className="text-[10px] text-muted-foreground">
                {" "}{t("未自定义时沿用上游 /v1/models 或 pi-catalog 的阶梯配置；留空的倍率字段沿用基础档。")}{" "}
              </p>
            ) : (
              <div className="min-w-0 rounded-lg border bg-background">
                <Table className="min-w-[36rem]">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-28">{t("阈值 (tokens)")}</TableHead>
                      <TableHead className="w-24">{t("输入")}</TableHead>
                      <TableHead className="w-24">{t("缓存读取")}</TableHead>
                      <TableHead className="w-24">{t("缓存写入")}</TableHead>
                      <TableHead className="w-24">{t("输出")}</TableHead>
                      <TableHead className="w-14">{t("操作")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tiers.map((tier, index) => (
                      <TableRow key={index}>
                        <TableCell>
                          <Input
                            inputMode="numeric"
                            className="h-8 font-mono text-xs tabular-nums"
                            placeholder="128000"
                            value={tier.inputThreshold}
                            onChange={(event) => setTier(index, { inputThreshold: event.target.value })}
                          />
                        </TableCell>
                        {(["inputRate", "cacheReadRate", "cacheWriteRate", "outputRate"] as const).map((field) => (
                          <TableCell key={field}>
                            <Input
                              inputMode="decimal"
                              className="h-8 font-mono text-xs tabular-nums"
                              placeholder={t("沿用")}
                              value={tier[field]}
                              onChange={(event) => setTier(index, { [field]: event.target.value })}
                            />
                          </TableCell>
                        ))}
                        <TableCell>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => onChange({ tiers: tiers.filter((_, position) => position !== index) })}
                          >
                            {" "}{t("删除")}{" "}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs">{t("峰谷计费")}</Label>
              {inheritedSchedule ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => onChange({ timeBased: metaScheduleToDraft(undefined) })}
                >
                  {" "}{t("重置为继承值")}{" "}
                </Button>
              ) : null}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {inheritedSchedule
                ? t("当前继承：谷时 ×{0}，时段 {1}", { "0": inheritedSchedule.offPeakMultiplier, "1": formatPeakWindows(inheritedSchedule) || "—" })
                : t("当前无峰谷配置；留空的时段 = 不启用周期性谷时价")}
            </p>
            <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
              <div className="grid gap-1">
                <Label htmlFor="model-off-peak" className="text-[10px]">
                  {" "}{t("谷时系数（峰值 = 1）")}{" "}
                </Label>
                <Input
                  id="model-off-peak"
                  inputMode="decimal"
                  className="h-8 font-mono text-xs tabular-nums"
                  placeholder="1"
                  value={schedule.offPeakMultiplier}
                  onChange={(event) =>
                    onChange({
                      timeBased: { ...schedule, offPeakMultiplier: event.target.value },
                    })
                  }
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="model-peak-windows" className="text-[10px]">
                  {" "}{t("峰值时段（UTC，每行一个；星期 0 = 周日）")}{" "}
                </Label>
                <textarea
                  id="model-peak-windows"
                  rows={3}
                  spellCheck={false}
                  placeholder={"1-5 01:00-09:00\n6-0 12:00-14:00"}
                  className="w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={schedule.peakWindows}
                  onChange={(event) => onChange({ timeBased: { ...schedule, peakWindows: event.target.value } })}
                />
              </div>
            </div>
          </div>
        </div>
        <ScrollBar orientation="horizontal" />
        </ScrollArea>

        <DialogFooter className="shrink-0">
          {onCancel ? <Button type="button" variant="outline" onClick={onCancel}>{t("取消")}</Button> : null}
          <Button type="button" onClick={onClose}>
            {" "}{t("完成")}{" "}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
