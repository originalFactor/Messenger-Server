import { LanguageSwitcher } from "@/components/i18n/language-switcher";
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

import { getTranslator } from "@/lib/i18n/server";
import Link from "next/link";
import { BackButton } from "@/components/back-button";
import { ModelPlazaGrid } from "@/components/model-plaza-grid";
import { getModelPlaza, type PlazaModel } from "@/lib/model-plaza";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  const t = await getTranslator();
  return {
  title: t("模型广场 - Messenger Cloud"),
};
}

interface PlazaPageData {
  models: PlazaModel[];
  failed: boolean;
}

/** 数据装配放在组件外的普通函数里，避免在渲染期间直接调用 Date.now()。 */
async function loadPlaza(): Promise<PlazaPageData> {
  try {
    const models = await getModelPlaza();
    return { models, failed: false };
  } catch (error) {
    console.error("Unable to load the model plaza.", error);
    return { models: [], failed: true };
  }
}

export default async function ModelPlazaPage() {
  const t = await getTranslator();
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
          <div className="flex items-center gap-2"><LanguageSwitcher /><BackButton /></div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-12">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">{t("模型广场")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {" "}{t("这里是当前可用的全部模型及其价格。输入、输出和缓存读取分别计价。 同一模型若由多个来源提供且价格不同，显示为区间，按实际服务的来源结算。")}{" "}
          </p>
        </div>

        {failed ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t("模型数据加载失败，请稍后刷新重试。")}</p>
        ) : (
          <ModelPlazaGrid models={models} />
        )}
      </main>
    </div>
  );
}
