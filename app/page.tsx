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
import { requireUserSession } from "@/lib/auth";
import { listPlans } from "@/lib/storage";
import type { PlanDoc } from "@/lib/types";

export const dynamic = "force-dynamic";

function formatQuota(tokens: number): string {
  if (tokens >= 100_000_000) return `${(tokens / 100_000_000).toFixed(tokens % 100_000_000 === 0 ? 0 : 1)} 亿 tokens`;
  if (tokens >= 10_000) return `${(tokens / 10_000).toFixed(tokens % 10_000 === 0 ? 0 : 1)} 万 tokens`;
  return `${tokens} tokens`;
}

export default async function HomePage() {
  const session = await requireUserSession();
  let plans: PlanDoc[] = [];
  try {
    plans = await listPlans({ enabledOnly: true });
  } catch (error) {
    console.error("Unable to load public plans for the homepage.", error);
  }

  return (
    <main>
      <div className="shell">
        <header className="topbar">
          <Link className="brand" href="/">Messenger Cloud</Link>
          <nav className="topnav">
            {session ? (
              <Link className="button button-small" href="/console">进入控制台</Link>
            ) : (
              <>
                <Link href="/login">登录</Link>
                <Link className="button button-small" href="/register">注册</Link>
              </>
            )}
          </nav>
        </header>

        <section className="hero">
          <div className="panel">
            <div className="kicker">Messenger Cloud</div>
            <h1 className="title">为 Messenger 而生的云端服务。</h1>
            <p className="muted">
              一个账号，多端同步。Messenger Cloud 为 Messenger 应用提供账号体系、
              增量云同步与内置 AI API：使用卡密兑换套餐额度，通过 OpenAI 兼容接口
              从上游模型服务获得对话能力，无需自备 API Key。
            </p>
            <p className="row" style={{ marginTop: 20 }}>
              <Link className="button" href={session ? "/console" : "/register"}>
                {session ? "打开控制台" : "立即注册"}
              </Link>
              <Link className="button-secondary" href="https://github.com/ECSDevs/Messenger">
                下载 Messenger
              </Link>
            </p>
          </div>
          <div className="panel grid">
            <div>
              <div className="kicker">云同步</div>
              <p className="muted">
                会话、Agent 与服务商配置按版本增量同步，手机、平板、桌面与手表数据一致，
                换机不丢历史。
              </p>
            </div>
            <div>
              <div className="kicker">内置 AI API</div>
              <p className="muted">
                登录即自动配置云端 AI 服务商，对话直接可用；标准 OpenAI 兼容协议
                （/v1/models、/v1/chat/completions），额度按模型倍率计费。
              </p>
            </div>
            <div>
              <div className="kicker">卡密套餐</div>
              <p className="muted">
                使用卡密兑换套餐额度，有效期自动顺延；在控制台随时查看余额、
                用量明细与兑换记录。
              </p>
            </div>
          </div>
        </section>

        <h2 className="section-title">套餐</h2>
        {plans.length === 0 ? (
          <div className="panel muted">暂无可售套餐，敬请期待。</div>
        ) : (
          <div className="plan-grid">
            {plans.map((plan) => (
              <div className="panel" key={plan._id}>
                <div className="kicker">{plan.name}</div>
                <div className="plan-price">{plan.price || formatQuota(plan.quotaTokens)}</div>
                <p className="plan-quota">
                  {formatQuota(plan.quotaTokens)} · 有效期 {plan.validityDays} 天
                </p>
                {plan.description ? <p className="muted">{plan.description}</p> : null}
              </div>
            ))}
          </div>
        )}

        <footer className="footer">
          <span>© {new Date().getFullYear()} ECSDevs · Messenger Cloud</span>
          <span className="mono">{process.env.APP_BASE_URL ?? ""}</span>
        </footer>
      </div>
    </main>
  );
}
