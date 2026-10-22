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
import { Badge } from "@/components/ui/badge";
import { EmailCard } from "@/components/console/email-card";
import { ProfileCard } from "@/components/console/profile-card";
import { requireUserSession } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { mailEnabled } from "@/lib/mail";
import { getUserById } from "@/lib/storage";

export const dynamic = "force-dynamic";

export const metadata = { title: "用户中心" };

/** 用户中心：头像 / 昵称 / 登录邮箱。三者的写入端点各不相同（见各组件注释）。 */
export default async function ConsoleAccountPage() {
  const session = await requireUserSession();
  if (!session) {
    redirect("/login");
  }

  const user = await getUserById(session.sub);
  if (!user) {
    redirect("/login");
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">用户中心</h1>
        <Badge variant={user.role === "admin" ? "default" : "secondary"}>
          {user.role === "admin" ? "管理员" : "用户"}
        </Badge>
        <span className="text-xs text-muted-foreground">
          注册于 {formatDateTime(user.createdAt)}
          {user.lastLoginAt ? ` · 最近登录 ${formatDateTime(user.lastLoginAt)}` : ""}
        </span>
      </div>

      <ProfileCard
        displayName={user.displayName}
        email={user.email}
        // Relative: the console is same-origin with the avatar proxy, so the
        // session cookie is sent even when APP_BASE_URL points elsewhere.
        avatarUrl={user.avatarUrl ? "/api/avatars/user" : null}
        avatarVersion={user.avatarVersion ?? null}
      />

      <EmailCard email={user.email} emailVerifiedAt={user.emailVerifiedAt} mailEnabled={mailEnabled()} />
    </div>
  );
}
