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
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { requireUserSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (await requireUserSession()) {
    redirect("/console");
  }
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <Link className="flex items-center gap-2.5 text-sm font-semibold tracking-tight" href="/">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" className="size-5 rounded-md" />
          Messenger Cloud
        </Link>
        <AuthForm mode="register" />
      </div>
    </main>
  );
}
