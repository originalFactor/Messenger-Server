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

import { useCallback, useEffect, useRef, useState } from "react";

/** Same budget as the Rust core: a call that is still waiting after this is cancelled. */
const TOOL_TIMEOUT_MS = 10 * 60 * 1000;
const DEVICE_ID_KEY = "messenger.web.deviceId";

export type RemoteToolRequest = {
  /** The device that owns the project's workspace (`ProjectDoc.deviceId`). */
  targetDeviceId: string;
  projectId: string;
  conversationId: string;
  name: string;
  argumentsJson: string;
  signal?: AbortSignal;
};

export type RemoteToolResult = { output: string; isError: boolean };

type Pending = {
  target: string;
  settle: (result: RemoteToolResult, cancelRemote?: boolean) => void;
};

function failure(message: string): RemoteToolResult {
  return { output: message, isError: true };
}

/**
 * One id per browser tab: a shared id would make two tabs replace each other's relay connection.
 * The relay only accepts `[A-Za-z0-9_-]{1,64}`.
 */
function loadDeviceId(): string {
  const fresh = `web-${crypto.randomUUID()}`;
  try {
    const stored = sessionStorage.getItem(DEVICE_ID_KEY);
    if (stored) return stored;
    sessionStorage.setItem(DEVICE_ID_KEY, fresh);
  } catch {
    // Storage can be unavailable (private mode); an in-memory id is enough for this page load.
  }
  return fresh;
}

async function postRelay(path: "tool-call" | "tool-cancel", payload: unknown): Promise<string | null> {
  const response = await fetch(`/api/remote/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.ok) return null;
  if (response.status === 409) return "项目所属设备不在线。";
  const detail = (await response.json().catch(() => null)) as { error?: string } | null;
  return detail?.error ?? `中转请求失败（${response.status}）。`;
}

/**
 * Registers this browser tab as a device on the account's relay (`/api/remote/events`) and lets it
 * run a project's workspace tools on the device that owns the project. Only the tool call crosses
 * devices; the LLM request and message persistence stay in the browser.
 */
export function useRemoteDevice() {
  const [connected, setConnected] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const deviceIdRef = useRef<string | null>(null);
  const pendingRef = useRef(new Map<string, Pending>());

  useEffect(() => {
    const deviceId = loadDeviceId();
    deviceIdRef.current = deviceId;
    const pending = pendingRef.current;
    const settleAll = (message: string, only?: (entry: Pending) => boolean) => {
      for (const entry of [...pending.values()]) {
        if (!only || only(entry)) entry.settle(failure(message));
      }
    };

    const source = new EventSource(`/api/remote/events?deviceId=${encodeURIComponent(deviceId)}`);
    source.onopen = () => setConnected(true);
    source.onerror = () => {
      setConnected(false);
      setDevices([]);
      settleAll("与中转服务的连接已断开。");
    };
    source.addEventListener("presence", (event) => {
      try {
        const online = (JSON.parse((event as MessageEvent<string>).data) as { devices?: string[] }).devices ?? [];
        setConnected(true);
        setDevices(online);
        settleAll("项目所属设备已离线。", (entry) => !online.includes(entry.target));
      } catch {
        // Ignore a malformed frame; the next presence event corrects the set.
      }
    });
    source.addEventListener("toolResult", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as { callId?: string; output?: string; isError?: boolean };
        const entry = data.callId ? pending.get(data.callId) : undefined;
        entry?.settle({ output: data.output ?? "", isError: data.isError === true });
      } catch {
        // A frame without a readable callId cannot be matched to a call.
      }
    });

    return () => {
      source.close();
      settleAll("与中转服务的连接已断开。");
      setConnected(false);
      setDevices([]);
    };
  }, []);

  const callTool = useCallback((request: RemoteToolRequest) => new Promise<RemoteToolResult>((resolve) => {
    const fromDeviceId = deviceIdRef.current;
    if (!fromDeviceId) {
      resolve(failure("尚未连接到中转服务。"));
      return;
    }
    const pending = pendingRef.current;
    const callId = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => settle(failure("已取消。"), true);
    function settle(result: RemoteToolResult, cancelRemote = false) {
      if (!pending.has(callId)) return;
      pending.delete(callId);
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      if (cancelRemote) {
        void postRelay("tool-cancel", { callId, targetDeviceId: request.targetDeviceId }).catch(() => undefined);
      }
      resolve(result);
    }
    pending.set(callId, { target: request.targetDeviceId, settle });
    timer = setTimeout(() => settle(failure("工具调用超时（10 分钟）。"), true), TOOL_TIMEOUT_MS);
    if (request.signal?.aborted) {
      onAbort();
      return;
    }
    request.signal?.addEventListener("abort", onAbort, { once: true });

    postRelay("tool-call", {
      callId,
      fromDeviceId,
      targetDeviceId: request.targetDeviceId,
      projectId: request.projectId,
      conversationId: request.conversationId,
      name: request.name,
      argumentsJson: request.argumentsJson,
    }).then(
      (error) => {
        if (error) settle(failure(error));
      },
      (error: unknown) => settle(failure(error instanceof Error ? error.message : "中转请求失败。")),
    );
  }), []);

  return { connected, devices, callTool };
}
