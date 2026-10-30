/*
 * Copyright 2026 originalFactor
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { requireUserSession } from "@/lib/auth";
import { getModelPlaza } from "@/lib/model-plaza";
import { getDeltaSince } from "@/lib/storage";
import { ConsoleManagement } from "@/components/console/console-management";

export const dynamic = "force-dynamic";

export default async function ConsoleManagePage() {
  const session = await requireUserSession();
  if (!session) return null;
  const [sync, builtinModels] = await Promise.all([getDeltaSince(session.sub, 0), getModelPlaza()]);

  return (
    <ConsoleManagement
      initialAgents={sync.agents.filter((item) => !item.deleted)}
      initialProviders={sync.providers.filter((item) => !item.deleted)}
      initialProjects={sync.projects.filter((item) => !item.deleted)}
      builtinModels={builtinModels}
    />
  );
}
