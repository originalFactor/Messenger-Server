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

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 返回按钮：优先走浏览器历史回退（从控制台等入口进入时回到来源页），
 * 没有可回退的历史时（如直接打开链接）才退回 fallbackHref。
 */
export function BackButton({ fallbackHref = "/", children = "返回" }: { fallbackHref?: string; children?: React.ReactNode }) {
  const router = useRouter();

  return (
    <Button
      variant="outline"
      size="sm"
      type="button"
      onClick={() => {
        if (window.history.length > 1) {
          router.back();
        } else {
          router.push(fallbackHref);
        }
      }}
    >
      <ArrowLeft />
      {children}
    </Button>
  );
}