"use client";

import { useTranslator } from "@/components/i18n/locale-provider";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { applyProviderModelMetadata } from "@/lib/provider-model-metadata";
import type { ModelEmbed } from "@/lib/types";
import type { CatalogModelMetadata } from "@/lib/pi-catalog";

type MetadataResult = { metadata: CatalogModelMetadata | null; degraded: boolean };
type LoadState = { modelId: string; cloud: boolean; result?: MetadataResult; error?: string };

/** Fetch once per effective model; metadata never rewrites editable settings. */
export function useModelMetadata(modelId: string | null | undefined, cloud: boolean, model?: ModelEmbed) {
  const t = useTranslator();
  const router = useRouter();
  const requestKey = modelId ? `/api/models/metadata?modelId=${encodeURIComponent(modelId)}${cloud ? "&cloud=1" : model?.catalogModelId ? `&catalogModelId=${encodeURIComponent(model.catalogModelId)}` : ""}` : null;
  const [state, setState] = useState<LoadState | null>(null);
  useEffect(() => {
    if (!requestKey) return;
    const controller = new AbortController();
    void fetch(requestKey, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (response.status === 401) router.replace("/login");
        if (!response.ok) throw new Error(body.error || t("获取模型 metadata 失败"));
        if (!controller.signal.aborted) {
          setState({ modelId: requestKey, cloud, result: body as MetadataResult });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : t("获取模型 metadata 失败");
        setState({ modelId: requestKey, cloud, error: message });
        toast.error(message);
      });
    return () => controller.abort();
  }, [requestKey, cloud, router, t]);
  const current = state !== null && state.modelId === requestKey && state.cloud === cloud ? state : null;
  const metadata = current?.result?.metadata;
  return { modelId, metadata: cloud ? metadata ?? null : applyProviderModelMetadata(metadata ?? null, model?.modelId === modelId ? model : undefined), result: current?.result, error: current?.error, loading: Boolean(modelId && !current) };
}

/** All capability, loading and error copy belongs beside the model chooser. */
export function ModelMetadataSummary({ state }: { state: ReturnType<typeof useModelMetadata> }) {
  const t = useTranslator();
  const { metadata, loading } = state;
  const efforts = metadata?.reasoningEfforts ?? [];
  return (
    <div className="grid min-w-0 gap-2">
      {loading ? <p className="text-xs text-muted-foreground">{t("正在读取模型 metadata…")}</p> : null}
      {state.error ? <p role="alert" className="text-xs text-destructive">{state.error}</p> : null}
      {!state.modelId ? <p className="text-xs text-muted-foreground">{t("选择模型后显示可用的 reasoning efforts。")}</p> : null}
      {metadata ? (
        <p className="text-xs text-muted-foreground">
          {metadata.contextWindow ? t("上下文 {0} tokens · ", { "0": metadata.contextWindow.toLocaleString(t.locale) }) : ""}
          {metadata.maxOutputTokens ? t("最大输出 {0} tokens · ", { "0": metadata.maxOutputTokens.toLocaleString(t.locale) }) : ""}
          {metadata.inputModalities.length ? t("输入 {0} · ", { "0": metadata.inputModalities.join(" / ") }) : ""}
          {efforts.length ? t("按模型元数据提供推理档位。") : metadata.reasoning === false ? t("该模型不支持推理。") : t("目录未提供可调推理档位。")}
        </p>
      ) : state.result ? <p className="text-xs text-muted-foreground">{t("未找到该模型的 metadata，保留当前设置。")}</p> : null}
      {state.result?.degraded ? <p className="text-xs text-muted-foreground">{t("模型目录暂不可用，能力信息可能来自旧快照或暂时缺失。")}</p> : null}
    </div>
  );
}
