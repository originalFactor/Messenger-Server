"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CatalogModelMetadata } from "@/lib/pi-catalog";

type MetadataResult = { metadata: CatalogModelMetadata | null; degraded: boolean };
type LoadState = { modelId: string; result?: MetadataResult; error?: string };
const DEFAULT_VALUE = "__model_default__";

/** Catalog values stay read-only: loading/changing models never rewrites an editor draft. */
export function ReasoningEffortSelect({ id, modelId, value, onChange, disabled, defaultLabel = "模型默认" }: {
  id: string;
  modelId: string | null | undefined;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  defaultLabel?: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<LoadState | null>(null);
  useEffect(() => {
    if (!modelId) return;
    const controller = new AbortController();
    void fetch(`/api/models/metadata?modelId=${encodeURIComponent(modelId)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (response.status === 401) router.replace("/login");
        if (!response.ok) throw new Error(body.error || "获取模型 metadata 失败");
        if (!controller.signal.aborted) setState({ modelId, result: body as MetadataResult });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "获取模型 metadata 失败";
        setState({ modelId, error: message });
        toast.error(message);
      });
    return () => controller.abort();
  }, [modelId, router]);
  const current = state?.modelId === modelId ? state : null;
  const metadata = current?.result?.metadata;
  const efforts = metadata?.reasoningEfforts ?? [];
  const preservedValue = value && !efforts.includes(value);
  const loading = Boolean(modelId && !current);

  return (
    <div className="grid min-w-0 gap-2">
      <Select value={value || DEFAULT_VALUE} disabled={disabled} onValueChange={(next) => onChange(next === DEFAULT_VALUE ? "" : next)}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_VALUE}>{defaultLabel}{defaultLabel === "模型默认" && metadata?.defaultReasoningEffort ? `（${metadata.defaultReasoningEffort}）` : ""}</SelectItem>
          {efforts.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
          {preservedValue ? <SelectItem value={value}>{value}（已保存，目录未列出）</SelectItem> : null}
        </SelectContent>
      </Select>
      {loading ? <p className="text-xs text-muted-foreground">正在读取模型 metadata…</p> : null}
      {current?.error ? <p role="alert" className="text-xs text-destructive">{current.error}</p> : null}
      {!modelId ? <p className="text-xs text-muted-foreground">选择模型后显示可用的 reasoning efforts。</p> : null}
      {metadata ? (
        <p className="text-xs text-muted-foreground">
          {metadata.contextWindow ? `上下文 ${metadata.contextWindow.toLocaleString("en-US")} tokens · ` : ""}
          {metadata.maxOutputTokens ? `最大输出 ${metadata.maxOutputTokens.toLocaleString("en-US")} tokens · ` : ""}
          {efforts.length ? "按模型目录提供推理档位。" : metadata.reasoning === false ? "该模型不支持推理。" : "目录未提供可调推理档位。"}
        </p>
      ) : current?.result ? <p className="text-xs text-muted-foreground">未找到该模型的 metadata，保留当前设置。</p> : null}
      {current?.result?.degraded ? <p className="text-xs text-muted-foreground">模型目录暂不可用，能力信息可能来自旧快照或暂时缺失。</p> : null}
    </div>
  );
}
