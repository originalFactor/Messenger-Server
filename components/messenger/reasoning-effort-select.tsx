"use client";

import { useTranslator } from "@/components/i18n/locale-provider";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CatalogModelMetadata } from "@/lib/pi-catalog";

type MetadataResult = { metadata: CatalogModelMetadata | null; degraded: boolean };
type LoadState = { modelId: string; cloud: boolean; result?: MetadataResult; error?: string };
const DEFAULT_VALUE = "__model_default__";

/** Catalog values stay read-only: loading/changing models never rewrites an editor draft. */
export function ReasoningEffortSelect({ id, modelId, value, onChange, disabled, cloud = false, onMetadata, defaultLabel = "模型默认" }: {
  id: string;
  modelId: string | null | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  cloud?: boolean;
  onMetadata?: (metadata: CatalogModelMetadata | null) => void;
  defaultLabel?: string;
}) {
  const t = useTranslator();
  const router = useRouter();
  const [state, setState] = useState<LoadState | null>(null);
  useEffect(() => {
    if (!modelId) return;
    const controller = new AbortController();
    void fetch(`/api/models/metadata?modelId=${encodeURIComponent(modelId)}${cloud ? "&cloud=1" : ""}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (response.status === 401) router.replace("/login");
        if (!response.ok) throw new Error(body.error || t("获取模型 metadata 失败"));
        if (!controller.signal.aborted) {
          setState({ modelId, cloud, result: body as MetadataResult });
          onMetadata?.(body.metadata ?? null);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : t("获取模型 metadata 失败");
        setState({ modelId, cloud, error: message });
        toast.error(message);
      });
    return () => controller.abort();
  }, [modelId, cloud, router, onMetadata, t]);
  const current = state !== null && state.modelId === modelId && state.cloud === cloud ? state : null;
  const metadata = current?.result?.metadata;
  const efforts = metadata?.reasoningEfforts ?? [];
  const preservedValue = value && !efforts.includes(value);
  const loading = Boolean(modelId && !current);

  return (
    <div className="grid min-w-0 gap-2">
      <Select value={value || DEFAULT_VALUE} disabled={disabled} onValueChange={(next) => onChange(next === DEFAULT_VALUE ? "" : next)}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_VALUE}>{t(defaultLabel)}{defaultLabel === "模型默认" && metadata?.defaultReasoningEffort ? `（${metadata.defaultReasoningEffort}）` : ""}</SelectItem>
          {efforts.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
          {preservedValue ? <SelectItem value={value}>{value}{t("（已保存，目录未列出）")}</SelectItem> : null}
        </SelectContent>
      </Select>
      {loading ? <p className="text-xs text-muted-foreground">{t("正在读取模型 metadata…")}</p> : null}
      {current?.error ? <p role="alert" className="text-xs text-destructive">{current.error}</p> : null}
      {!modelId ? <p className="text-xs text-muted-foreground">{t("选择模型后显示可用的 reasoning efforts。")}</p> : null}
      {metadata ? (
        <p className="text-xs text-muted-foreground">
          {metadata.contextWindow ? t("上下文 {0} tokens · ", { "0": metadata.contextWindow.toLocaleString("en-US") }) : ""}
          {metadata.maxOutputTokens ? t("最大输出 {0} tokens · ", { "0": metadata.maxOutputTokens.toLocaleString("en-US") }) : ""}
          {metadata.inputModalities.length ? t("输入 {0} · ", { "0": metadata.inputModalities.join(" / ") }) : ""}
          {efforts.length ? t("按模型元数据提供推理档位。") : metadata.reasoning === false ? t("该模型不支持推理。") : t("目录未提供可调推理档位。")}
        </p>
      ) : current?.result ? <p className="text-xs text-muted-foreground">{t("未找到该模型的 metadata，保留当前设置。")}</p> : null}
      {current?.result?.degraded ? <p className="text-xs text-muted-foreground">{t("模型目录暂不可用，能力信息可能来自旧快照或暂时缺失。")}</p> : null}
    </div>
  );
}
