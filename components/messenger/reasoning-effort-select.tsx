"use client";

import { useTranslator } from "@/components/i18n/locale-provider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CatalogModelMetadata } from "@/lib/pi-catalog";

const DEFAULT_VALUE = "__model_default__";

export function ReasoningEffortSelect({ id, metadata, value, onChange, disabled, defaultLabel = "模型默认" }: {
  id: string;
  metadata: CatalogModelMetadata | null;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  defaultLabel?: string;
}) {
  const t = useTranslator();
  const efforts = metadata?.reasoningEfforts ?? [];
  const preservedValue = value && !efforts.includes(value);
  return (
    <Select value={value || DEFAULT_VALUE} disabled={disabled} onValueChange={(next) => onChange(next === DEFAULT_VALUE ? "" : next)}>
      <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_VALUE}>{t(defaultLabel)}{defaultLabel === "模型默认" && metadata?.defaultReasoningEffort ? `（${metadata.defaultReasoningEffort}）` : ""}</SelectItem>
        {efforts.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
        {preservedValue ? <SelectItem value={value}>{value}{t("（已保存，目录未列出）")}</SelectItem> : null}
      </SelectContent>
    </Select>
  );
}
