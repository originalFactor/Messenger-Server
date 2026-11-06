"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useTranslator } from "./locale-provider";
import { LOCALE_COOKIE, resolveLocale } from "@/lib/i18n";

export function LanguageSwitcher() {
  const t = useTranslator();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={pending} aria-label={t("切换语言")}>
          <Languages className="size-4" />
          <span className="hidden sm:inline">{t.locale === "zh-CN" ? "简体中文" : "English"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={t.locale} onValueChange={(value) => {
          const locale = resolveLocale(value);
          if (locale === t.locale) return;
          document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
          startTransition(() => router.refresh());
        }}>
          <DropdownMenuRadioItem value="zh-CN" lang="zh-CN">简体中文</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="en-US" lang="en-US">English (US)</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
