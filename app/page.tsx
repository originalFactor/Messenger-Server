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
import { ArrowRight, CloudCog, CreditCard, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUserSession } from "@/lib/auth";
import { listPlans } from "@/lib/storage";
import type { PlanDoc } from "@/lib/types";

export const dynamic = "force-dynamic";

function formatQuota(tokens: number): string {
  if (tokens >= 100_000_000) return `${(tokens / 100_000_000).toFixed(tokens % 100_000_000 === 0 ? 0 : 1)} 亿 tokens`;
  if (tokens >= 10_000) return `${(tokens / 10_000).toFixed(tokens % 10_000 === 0 ? 0 : 1)} 万 tokens`;
  return `${tokens} tokens`;
}

const features = [
  {
    icon: RefreshCw,
    kicker: "SYNC",
    title: "版本化增量同步",
    description:
      "会话、Agent 与服务商配置按版本水位增量同步，手机、平板、桌面与手表数据一致，换机不丢历史。",
  },
  {
    icon: CloudCog,
    kicker: "AI API",
    title: "内置云 AI 服务商",
    description:
      "登录即自动配置，对话直接可用。标准 OpenAI 兼容协议（/v1/models、/v1/chat/completions），额度按模型倍率计费。",
  },
  {
    icon: CreditCard,
    kicker: "BILLING",
    title: "卡密套餐体系",
    description: "卡密兑换套餐额度，有效期自动顺延；控制台随时查看余额、用量明细与兑换记录。",
  },
];

export default async function HomePage() {
  const session = await requireUserSession();
  let plans: PlanDoc[] = [];
  try {
    plans = await listPlans({ enabledOnly: true });
  } catch (error) {
    console.error("Unable to load public plans for the homepage.", error);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 border-b bg-background/70 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <Link className="flex items-center gap-2.5 text-sm font-semibold tracking-tight" href="/">
            <span className="size-2.5 rounded-[4px] bg-gradient-to-br from-blue-500 to-purple-500 shadow-[0_0_12px] shadow-blue-500/30" />
            Messenger Cloud
          </Link>
          <nav className="flex items-center gap-5">
            <Link className="hidden text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:block" href="#features">
              功能
            </Link>
            <Link className="hidden text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:block" href="#pricing">
              套餐
            </Link>
            <Link className="hidden text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:block" href="https://github.com/ECSDevs/Messenger">
              GitHub
            </Link>
            {session ? (
              <Button asChild size="sm">
                <Link href="/console">进入控制台</Link>
              </Button>
            ) : (
              <>
                <Link className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground" href="/login">
                  登录
                </Link>
                <Button asChild size="sm">
                  <Link href="/register">注册</Link>
                </Button>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6">
        <section className="relative py-24 text-center sm:py-32">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:36px_36px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,#000_35%,transparent_100%)]"
          />
          <div className="relative mx-auto flex max-w-2xl flex-col items-center gap-6">
            <Badge variant="outline" className="font-mono tracking-widest">
              MESSENGER CLOUD
            </Badge>
            <h1 className="text-4xl font-bold tracking-tighter text-balance sm:text-6xl">
              云端同步。
              <br />
              <span className="bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 bg-clip-text text-transparent">
                内置 AI 能力。
              </span>
            </h1>
            <p className="max-w-xl text-balance text-muted-foreground">
              一个账号，多端一致。Messenger Cloud 为 Messenger 提供账号体系、增量云同步与
              OpenAI 兼容的 AI API —— 使用卡密兑换套餐，无需自备 API Key。
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button asChild>
                <Link href={session ? "/console" : "/register"}>
                  {session ? "打开控制台" : "立即注册"}
                  <ArrowRight />
                </Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="https://github.com/ECSDevs/Messenger">下载 Messenger</Link>
              </Button>
            </div>
          </div>
        </section>

        <section id="features" className="scroll-mt-16">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <Card key={feature.kicker} className="transition-colors hover:border-muted-foreground/40">
                <CardHeader>
                  <span className="font-mono text-xs font-medium tracking-widest text-muted-foreground">
                    {feature.kicker}
                  </span>
                  <CardTitle className="text-base">{feature.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm leading-relaxed text-muted-foreground">
                  {feature.description}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section id="pricing" className="scroll-mt-16 pb-24 pt-20">
          <h2 className="mb-6 text-2xl font-bold tracking-tight">套餐</h2>
          {plans.length === 0 ? (
            <Card>
              <CardContent className="text-sm text-muted-foreground">暂无可售套餐，敬请期待。</CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {plans.map((plan) => (
                <Card key={plan._id} className="transition-colors hover:border-muted-foreground/40">
                  <CardHeader>
                    <CardTitle className="text-sm font-medium text-muted-foreground">{plan.name}</CardTitle>
                    <div className="text-3xl font-bold tracking-tighter">
                      {plan.price || formatQuota(plan.quotaTokens)}
                    </div>
                    <CardDescription>
                      {formatQuota(plan.quotaTokens)} · 有效期 {plan.validityDays} 天
                    </CardDescription>
                  </CardHeader>
                  {plan.description ? (
                    <CardContent className="text-sm text-muted-foreground">{plan.description}</CardContent>
                  ) : null}
                </Card>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-8 text-sm text-muted-foreground">
          <span>© {new Date().getFullYear()} ECSDevs · Messenger Cloud</span>
          <span className="font-mono text-xs">{process.env.APP_BASE_URL ?? ""}</span>
        </div>
      </footer>
    </div>
  );
}
