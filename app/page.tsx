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
    <>
      <header className="site-header">
        <div className="shell site-header-inner">
          <Link className="brand" href="/">
            <span className="brand-dot" />
            Messenger Cloud
          </Link>
          <nav className="topnav">
            <a className="nav-link" href="#features">功能</a>
            <a className="nav-link" href="#pricing">套餐</a>
            <a className="nav-link" href="https://github.com/ECSDevs/Messenger">GitHub</a>
            {session ? (
              <Link className="button button-small" href="/console">进入控制台</Link>
            ) : (
              <>
                <Link className="nav-link" href="/login">登录</Link>
                <Link className="button button-small" href="/register">注册</Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="shell">
        <section className="hero">
          <div className="hero-inner">
            <span className="kicker">MESSENGER CLOUD</span>
            <h1>
              云端同步。
              <br />
              <span className="hero-gradient">内置 AI 能力。</span>
            </h1>
            <p>
              一个账号，多端一致。Messenger Cloud 为 Messenger 提供账号体系、
              增量云同步与 OpenAI 兼容的 AI API —— 使用卡密兑换套餐，
              无需自备 API Key。
            </p>
            <div className="hero-cta">
              <Link className="button" href={session ? "/console" : "/register"}>
                {session ? "打开控制台" : "立即注册"}
              </Link>
              <Link className="button-secondary" href="https://github.com/ECSDevs/Messenger">
                下载 Messenger
              </Link>
            </div>
          </div>
        </section>

        <section id="features">
          <div className="feature-grid">
            <div className="feature-card">
              <span className="mono-kicker">SYNC</span>
              <h3>版本化增量同步</h3>
              <p>
                会话、Agent 与服务商配置按版本水位增量同步，手机、平板、桌面与
                手表数据一致，换机不丢历史。
              </p>
            </div>
            <div className="feature-card">
              <span className="mono-kicker">AI API</span>
              <h3>内置云 AI 服务商</h3>
              <p>
                登录即自动配置，对话直接可用。标准 OpenAI 兼容协议
                （/v1/models、/v1/chat/completions），额度按模型倍率计费。
              </p>
            </div>
            <div className="feature-card">
              <span className="mono-kicker">BILLING</span>
              <h3>卡密套餐体系</h3>
              <p>
                卡密兑换套餐额度，有效期自动顺延；控制台随时查看余额、
                用量明细与兑换记录。
              </p>
            </div>
          </div>
        </section>

        <section id="pricing">
          <h2 className="section-title">套餐</h2>
          {plans.length === 0 ? (
            <div className="panel muted">暂无可售套餐，敬请期待。</div>
          ) : (
            <div className="plan-grid">
              {plans.map((plan) => (
                <div className="plan-card" key={plan._id}>
                  <span className="kicker">{plan.name}</span>
                  <div className="plan-price">{plan.price || formatQuota(plan.quotaTokens)}</div>
                  <p className="plan-quota">
                    {formatQuota(plan.quotaTokens)} · 有效期 {plan.validityDays} 天
                  </p>
                  {plan.description ? <p className="plan-desc">{plan.description}</p> : null}
                </div>
              ))}
            </div>
          )}
        </section>

        <footer className="site-footer">
          <span>© {new Date().getFullYear()} ECSDevs · Messenger Cloud</span>
          <span className="mono">{process.env.APP_BASE_URL ?? ""}</span>
        </footer>
      </main>
    </>
  );
}
