"use client";

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

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserAvatar } from "@/components/console/user-avatar";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export interface ProfileCardProps {
  /** 昵称；null = 未设置。 */
  displayName: string | null;
  email: string;
  /** 已设头像时的可认证访问地址；null = 未设置。 */
  avatarUrl: string | null;
  /** 头像版本，用于击穿浏览器缓存。 */
  avatarVersion: number | null;
}

/**
 * 头像与昵称。头像走 `PUT /api/avatars/user`——与 Messenger App 用的是同一个
 * 端点与同一份 Blob，所以在这里换头像，App 下次刷新会拉到同一张图；昵称走
 * `PUT /api/auth/profile`，随 `/api/auth/me` 一起下发给客户端。
 */
export function ProfileCard({ displayName, email, avatarUrl, avatarVersion }: ProfileCardProps) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(displayName ?? "");
  const [busy, setBusy] = useState<"avatar" | "name" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const avatarSrc = avatarUrl ? `${avatarUrl}?v=${avatarVersion ?? 0}` : null;
  const trimmed = name.trim();
  const nameChanged = trimmed !== (displayName ?? "");

  async function upload(file: File) {
    setError(null);
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError("头像只支持 JPEG、PNG、WebP 或 GIF。");
      return;
    }
    if (file.size === 0 || file.size > MAX_AVATAR_BYTES) {
      setError("头像大小必须在 5 MiB 以内。");
      return;
    }
    setBusy("avatar");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/avatars/user", { method: "PUT", body: form });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(payload?.error ?? "头像上传失败，请稍后重试。");
        return;
      }
      toast.success("头像已更新");
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setBusy(null);
      if (fileInput.current) {
        fileInput.current.value = "";
      }
    }
  }

  async function removeAvatar() {
    setError(null);
    if (!window.confirm("移除后 App 端也会在下次刷新时失去该头像，确定移除？")) {
      return;
    }
    setBusy("remove");
    try {
      const response = await fetch("/api/avatars/user", { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "移除失败，请稍后重试。");
        return;
      }
      toast.success("头像已移除");
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy("name");
    try {
      const response = await fetch("/api/auth/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: trimmed === "" ? null : trimmed }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(payload?.error ?? "保存失败，请稍后重试。");
        return;
      }
      toast.success(trimmed === "" ? "已清除昵称，将显示邮箱" : "昵称已保存");
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">头像与昵称</CardTitle>
        <CardDescription>
          头像与 Messenger App 使用同一份云端文件，在任一客户端更换后，其它客户端刷新即可看到。
          昵称未设置时显示登录邮箱。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="flex flex-wrap items-center gap-4">
          <UserAvatar
            src={avatarSrc}
            name={trimmed || email}
            className="size-20 text-xl"
          />
          <div className="grid gap-2">
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPTED_TYPES.join(",")}
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void upload(file);
                  }
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInput.current?.click()}
                disabled={busy !== null}
              >
                {busy === "avatar" ? "上传中…" : avatarSrc ? "更换头像" : "上传头像"}
              </Button>
              {avatarSrc ? (
                <Button variant="ghost" size="sm" onClick={removeAvatar} disabled={busy !== null}>
                  {busy === "remove" ? "移除中…" : "移除头像"}
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">JPEG / PNG / WebP / GIF，最大 5 MiB。</p>
          </div>
        </div>

        <form className="grid max-w-md gap-2" onSubmit={saveName}>
          <Label htmlFor="profile-display-name">昵称</Label>
          <div className="flex gap-2">
            <Input
              id="profile-display-name"
              value={name}
              maxLength={32}
              placeholder="例如：小明"
              onChange={(event) => setName(event.target.value)}
              disabled={busy !== null}
            />
            <Button type="submit" disabled={busy !== null || !nameChanged}>
              {busy === "name" ? "保存中…" : "保存"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">1–32 个字符，留空则清除昵称。</p>
        </form>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
