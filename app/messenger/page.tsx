/*
 * Copyright 2026 originalFactor
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { getTranslator } from "@/lib/i18n/server";
import { redirect } from "next/navigation";
import { requireUserSession } from "@/lib/auth";
import { getModelPlaza } from "@/lib/model-plaza";
import {
  getUserById, listAgentsSince, listProjectsSince, listProvidersSince, listRecentWebConversations, SYNC_MAX_LIMIT,
} from "@/lib/storage";
import { MessengerApp } from "@/components/messenger/messenger-app";
import type { ProviderDoc } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function MessengerPage({ searchParams }: { searchParams: Promise<{ settings?: string }> }) {
  const t = await getTranslator();
  const session = await requireUserSession();
  if (!session) redirect("/login");

  const [builtinModels, user] = await Promise.all([getModelPlaza(), getUserById(session.sub)]);
  if (!user) redirect("/login");
  const [agentRows, providerRows, projectRows] = await Promise.all([
    listAgentsSince(session.sub, 0, user.syncVersion, SYNC_MAX_LIMIT),
    listProvidersSince(session.sub, 0, user.syncVersion, SYNC_MAX_LIMIT),
    listProjectsSince(session.sub, 0, user.syncVersion, SYNC_MAX_LIMIT),
  ]);
  const projects = projectRows.filter((project) => !project.deleted);
  const conversations = await listRecentWebConversations(session.sub, projects.map((project) => project._id));
  const { settings } = await searchParams;
  const builtinProvider: ProviderDoc = {
    _id: "builtin-messenger-cloud-ai",
    userId: session.sub,
    name: t("Messenger Cloud AI（内置）"),
    baseUrl: "",
    apiKey: "",
    apiFormat: "chat",
    models: builtinModels.map((model) => ({
      id: `builtin:${model.modelId}`,
      modelId: model.modelId,
      displayName: model.displayName ?? model.modelId,
      isEnabled: true,
      contextWindow: model.metadata?.contextWindow ?? null,
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
      builtinModels={builtinModels}
      initialManagementOpen={settings === "1"}
      initialAgents={agentRows.filter((agent) => !agent.deleted)}
      initialConversations={conversations}
      initialProviders={[builtinProvider, ...providerRows.filter((provider) => !provider.deleted)]}
      initialProjects={projects}
      userName={user?.displayName ?? user?.email ?? "You"}
      userAvatarUrl={user?.avatarUrl ? `/api/avatars/user?v=${user.avatarVersion ?? 0}` : null}
    />
  );
}
