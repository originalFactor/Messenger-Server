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
import { BackButton } from "@/components/back-button";
import { ModelPlazaGrid } from "@/components/model-plaza-grid";
import { getModelPlaza } from "@/lib/model-plaza";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "模型广场 - Messenger Cloud",
};

/** 数据装配放在组件外的普通函数里，避免在渲染期间直接调用 Date.now()。 */
async function loadPlaza(): Promise<{ models: Awaited<ReturnType<typeof getModelPlaza>>; failed: boolean }> {
  try {
    return { models: await getModelPlaza(), failed: false };
  } catch (error) {
    console.error("Unable to load the model plaza.", error);
    return { models: [], failed: true };
  }
}

export default async function ModelPlazaPage() {
  const { models, failed } = await loadPlaza();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 border-b bg-background/70 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <Link className="flex items-center gap-2.5 text-sm font-semibold tracking-tight" href="/">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="" className="size-5 rounded-md" />
            Messenger Cloud
          </Link>
          <BackButton />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-12">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">模型广场</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            当前可用的全部模型及其计费倍率。基准为 deepseek-v4.1-flash 的峰时输出费率（定为 1.0），
            其余模型的输入/输出倍率及 deepseek-v4.1-flash 自身的输入倍率均按该基准折算。
            单次调用费用 = 输入 tokens × 输入倍率 + 输出 tokens × 输出倍率（向上取整，至少 1）；
            多个上游提供同一模型且倍率不同时显示区间，实际按为你服务的上游计费。
          </p>
        </div>

        {failed ? (
          <p className="py-12 text-center text-sm text-muted-foreground">模型数据加载失败，请稍后刷新重试。</p>
        ) : (
          <ModelPlazaGrid models={models} />
        )}
      </main>
    </div>
  );
}
