import type { ConversationDoc, ProviderDoc } from "@/lib/types";

export const BUILTIN_PROVIDER_ID = "builtin-messenger-cloud-ai";

type ModelBinding = Pick<ConversationDoc, "providerId" | "overrideModelId">;

/** An explicit override is bound to one Provider, even when another serves the same ID. */
export function resolveConversationModel(providers: ProviderDoc[], agentModelId: string | null, binding?: ModelBinding | null) {
  const modelId = binding?.overrideModelId || agentModelId;
  const boundProvider = providers.find((provider) => !provider.deleted && provider._id === binding?.providerId);
  const enabledModel = (provider?: ProviderDoc) => provider?.models.find((model) => model.isEnabled && model.modelId === modelId);
  const provider = binding?.overrideModelId
    ? boundProvider
    : enabledModel(boundProvider) ? boundProvider : providers.find((item) => !item.deleted && enabledModel(item));
  return { provider, modelId, model: enabledModel(provider) };
}
