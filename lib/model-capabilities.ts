import type { CatalogMetadataMap, CatalogModelMetadata } from "@/lib/pi-catalog";
import type { UpstreamModelMeta } from "@/lib/types";
import { catalogModelDefault } from "@/lib/model-rates";

/** Field-wise inheritance, shared by Web, model discovery and admin previews. */
export function resolveModelCapabilities(modelId: string, catalog: CatalogMetadataMap, custom?: UpstreamModelMeta): CatalogModelMetadata {
  const base = catalogModelDefault(modelId, catalog, custom?.catalogModelId);
  const reasoning = custom?.reasoning ?? base?.reasoning ?? null;
  const efforts = reasoning === false ? [] : custom?.reasoningEfforts ?? base?.reasoningEfforts ?? [];
  return {
    displayName: custom?.displayName ?? base?.displayName ?? modelId,
    inputModalities: custom?.inputModalities ?? base?.inputModalities ?? ["text"],
    reasoning,
    reasoningEfforts: efforts,
    defaultReasoningEffort: base?.defaultReasoningEffort && efforts.includes(base.defaultReasoningEffort) ? base.defaultReasoningEffort : null,
    contextWindow: custom?.contextWindow ?? base?.contextWindow ?? null,
    maxOutputTokens: custom?.maxOutputTokens ?? base?.maxOutputTokens ?? null,
    supportsTemperature: custom?.supportsTemperature ?? base?.supportsTemperature ?? true,
    supportsTopP: custom?.supportsTopP ?? base?.supportsTopP ?? true,
    supportsPenalties: custom?.supportsPenalties ?? base?.supportsPenalties ?? true,
  };
}
