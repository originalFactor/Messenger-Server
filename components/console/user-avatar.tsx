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

import { useState } from "react";
import { cn } from "cn";

/**
 * 圆形账号头像。头像走认证代理（`/api/avatars/user`），未设置、加载失败
 * 或未登录时回落到首字母——绝不把 `<img>` 的 alt 文本当占位，否则布局里
 * 会冒出一行「当前头像」。
 */
export function UserAvatar({
  src,
  name,
  className,
}: {
  /** 可认证访问的头像地址；null = 未设置。 */
  src: string | null;
  /** 回落到首字母的显示名（昵称或邮箱）。 */
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = src !== null && !failed;

  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-medium text-foreground ring-1 ring-foreground/10",
        className,
      )}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
