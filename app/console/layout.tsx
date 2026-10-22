/*
 * Copyright 2026 originalFactor
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { redirect } from "next/navigation";
import { ConsoleShell } from "@/components/console/console-shell";
import { EmailVerificationBanner } from "@/components/console/email-verification-banner";
import { requireUserSession } from "@/lib/auth";
import { getUserById } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await requireUserSession();
  if (!session) {
    redirect("/login");
  }
  // 侧边栏与管理入口以数据库中的 role 为准，而不是旧 token 里的 claims。
  const user = await getUserById(session.sub);
  if (!user) {
    redirect("/login");
  }

  return (
    <ConsoleShell
      email={user.email}
      displayName={user.displayName}
      // Relative on purpose: the console is same-origin with the API, so the
      // session cookie rides along regardless of APP_BASE_URL. The API keeps
      // returning an absolute URL for the mobile clients.
      avatarUrl={user.avatarUrl ? `/api/avatars/user?v=${user.avatarVersion ?? 0}` : null}
      role={user.role}
    >
      {user.emailVerifiedAt === null ? <EmailVerificationBanner email={user.email} /> : null}
      {children}
    </ConsoleShell>
  );
}
