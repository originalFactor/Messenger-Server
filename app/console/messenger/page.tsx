/*
 * Copyright 2026 originalFactor
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { requireUserSession } from "@/lib/auth";
import { getModelPlaza } from "@/lib/model-plaza";
import { getDeltaSince, getUserById } from "@/lib/storage";
import { MessengerApp } from "@/components/messenger/messenger-app";
import type { ProviderDoc } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function MessengerPage() {
  const session = await requireUserSession();
  if (!session) return null;

  const [sync, builtinModels, user] = await Promise.all([getDeltaSince(session.sub, 0), getModelPlaza(), getUserById(session.sub)]);
  const builtinProvider: ProviderDoc = {
    _id: "builtin-messenger-cloud-ai",
    userId: session.sub,
    name: "Messenger Cloud AI（内置）",
    baseUrl: "",
    apiKey: "",
    apiFormat: "chat",
    models: builtinModels.map((model) => ({
      id: `builtin:${model.modelId}`,
      modelId: model.modelId,
      displayName: model.modelId,
      isEnabled: true,
      contextWindow: null,
      inputRate: model.inputRateMin,
      outputRate: model.outputRateMin,
      createdAt: 0,
    })),
    createdAt: 0,
    updatedAt: 0,
    version: 0,
    deleted: false,
  };
  return (
    <MessengerApp
      initialAgents={sync.agents.filter((agent) => !agent.deleted)}
      initialConversations={sync.conversations.filter((conversation) => !conversation.deleted)}
      initialProviders={[builtinProvider, ...sync.providers.filter((provider) => !provider.deleted)]}
      initialProjects={sync.projects.filter((project) => !project.deleted)}
      userName={user?.displayName ?? user?.email ?? "You"}
      userAvatarUrl={user?.avatarUrl ? `/api/avatars/user?v=${user.avatarVersion ?? 0}` : null}
    />
  );
}
