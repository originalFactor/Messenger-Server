"use client";

/*
 * Copyright 2026 ECSDevs
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

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export interface SidebarProps {
  email: string;
  role: "user" | "admin";
}

export function ConsoleSidebar({ email, role }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  const isActive = (href: string) =>
    href === "/console" ? pathname === "/console" : pathname.startsWith(href);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.push("/");
    router.refresh();
  }

  return (
    <aside className="sidebar">
      <Link className="brand" href="/">Messenger Cloud</Link>
      <div className="sidebar-section">用户功能区</div>
      <Link className={isActive("/console") ? "active" : ""} href="/console">概览</Link>
      <Link className={isActive("/console/finance") ? "active" : ""} href="/console/finance">财务</Link>

      {role === "admin" ? (
        <>
          <div className="sidebar-section">管理功能区</div>
          <Link className={isActive("/console/admin") && !pathname.startsWith("/console/admin/") ? "active" : ""} href="/console/admin">全站概览</Link>
          <Link className={isActive("/console/admin/plans") ? "active" : ""} href="/console/admin/plans">套餐管理</Link>
          <Link className={isActive("/console/admin/cards") ? "active" : ""} href="/console/admin/cards">开卡</Link>
          <Link className={isActive("/console/admin/upstreams") ? "active" : ""} href="/console/admin/upstreams">上游管理</Link>
        </>
      ) : null}

      <div className="sidebar-user">
        <div>{email}</div>
        {role === "admin" ? <span className="badge badge-accent" style={{ marginTop: 8 }}>管理员</span> : null}
        <div className="actions" style={{ marginTop: 10 }}>
          <button className="button button-secondary button-small" type="button" onClick={handleLogout}>
            退出登录
          </button>
        </div>
      </div>
    </aside>
  );
}
