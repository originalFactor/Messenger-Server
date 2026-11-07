"use client";

import { ChevronDown, LoaderCircle } from "lucide-react";
import { useTranslator } from "@/components/i18n/locale-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ProviderDoc } from "@/lib/types";

const menuScrollClass = "max-h-[min(22rem,calc(var(--radix-dropdown-menu-content-available-height)_-_0.5rem))] pr-2.5 [&_[data-slot=scroll-area-viewport]]:max-h-[inherit] [&_[data-slot=scroll-area-viewport]>div]:!block";

export type ConversationModelChoice = { providerId: string; modelId: string };

export function ConversationModelMenu({ providers, selection, label, disabled, saving, onSelect }: {
  providers: ProviderDoc[];
  selection: ConversationModelChoice | null;
  label: string;
  disabled: boolean;
  saving: boolean;
  onSelect: (choice: ConversationModelChoice | null) => void;
}) {
  const t = useTranslator();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="min-w-0 justify-start text-xs text-muted-foreground"
          disabled={disabled || saving} aria-busy={saving} title={label}>
          <span className="truncate">{label}</span>
          {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <ChevronDown className="size-3.5" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56 max-w-[calc(100vw-2rem)] overflow-hidden">
        <ScrollArea type="auto" className={menuScrollClass}>
          <DropdownMenuRadioGroup value={selection ? "" : "follow"} onValueChange={() => onSelect(null)}>
            <DropdownMenuRadioItem value="follow">{t("跟随 Agent")}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          {providers.filter((provider) => !provider.deleted).map((provider) => {
            const models = [...new Map(provider.models.filter((model) => model.isEnabled).map((model) => [model.modelId, model])).values()];
            return (
              <DropdownMenuSub key={provider._id}>
                <DropdownMenuSubTrigger textValue={provider.name}>
                  <span className="min-w-0 truncate" title={provider.name}>{provider.name}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuPortal>
                  <DropdownMenuSubContent className="max-h-(--radix-dropdown-menu-content-available-height) w-64 max-w-(--radix-dropdown-menu-content-available-width)">
                    <ScrollArea type="auto" className={menuScrollClass}>
                      {models.length ? (
                        <DropdownMenuRadioGroup value={selection?.providerId === provider._id ? selection.modelId : ""}
                          onValueChange={(modelId) => onSelect({ providerId: provider._id, modelId })}>
                          {models.map((model) => (
                            <DropdownMenuRadioItem key={model.modelId} value={model.modelId} textValue={model.displayName || model.modelId}>
                              <span className="min-w-0 truncate" title={model.modelId}>{model.displayName || model.modelId}</span>
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      ) : <DropdownMenuItem disabled>{t("该 Provider 暂无模型")}</DropdownMenuItem>}
                    </ScrollArea>
                  </DropdownMenuSubContent>
                </DropdownMenuPortal>
              </DropdownMenuSub>
            );
          })}
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
