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
import {
  ArrowLeftRight,
  CreditCard,
  Globe,
  Layers,
  LayoutDashboard,
  LogOut,
  Server,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export interface ConsoleShellProps {
  email: string;
  role: "user" | "admin";
  children: React.ReactNode;
}

export function ConsoleShell({ email, role, children }: ConsoleShellProps) {
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
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild size="lg">
                <Link href="/">
                  <span className="flex size-6 items-center justify-center rounded-[6px] bg-gradient-to-br from-blue-500 to-purple-500 text-primary-foreground shadow-[0_0_12px] shadow-blue-500/30">
                    <Globe className="size-3.5" />
                  </span>
                  <span className="font-semibold tracking-tight">Messenger Cloud</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>用户功能区</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/console")}>
                  <Link href="/console">
                    <LayoutDashboard />
                    <span>概览</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/console/finance")}>
                  <Link href="/console/finance">
                    <Wallet />
                    <span>财务</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>

          {role === "admin" ? (
            <SidebarGroup>
              <SidebarGroupLabel>管理功能区</SidebarGroupLabel>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={pathname === "/console/admin"}>
                    <Link href="/console/admin">
                      <Globe />
                      <span>全站概览</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isActive("/console/admin/plans")}>
                    <Link href="/console/admin/plans">
                      <Layers />
                      <span>套餐管理</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isActive("/console/admin/cards")}>
                    <Link href="/console/admin/cards">
                      <CreditCard />
                      <span>开卡</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isActive("/console/admin/upstreams")}>
                    <Link href="/console/admin/upstreams">
                      <Server />
                      <span>上游管理</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          ) : null}
        </SidebarContent>
        <SidebarFooter>
          <div className="grid gap-2.5 rounded-lg border bg-sidebar-accent/40 p-3 text-xs text-muted-foreground">
            <div className="flex items-center justify-between gap-2">
              <span className="break-all">{email}</span>
              {role === "admin" ? (
                <Badge variant="outline" className="shrink-0">
                  管理员
                </Badge>
              ) : null}
            </div>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              <LogOut />
              退出登录
            </Button>
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
          <span className="text-sm text-muted-foreground">控制台</span>
        </header>
        <div className="mx-auto w-full max-w-5xl flex-1 p-4 sm:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
