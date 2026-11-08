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

import { useTranslator } from "@/components/i18n/locale-provider";
import type { Translator } from "@/lib/i18n";
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

export type ControlEvent = { type: string; [key: string]: unknown };
type ControlPending = {
  update?: (event: ControlEvent) => void;
  resolve: (event: ControlEvent) => void;
  reject: (error: Error) => void;
};

async function postControl(payload: unknown) {
  const reply = await fetch("/api/remote/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!reply.ok) {
    const body = await reply.json().catch(() => null);
    throw new Error(body?.error ?? `HTTP ${reply.status}`);
  }
}

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

async function postRelay(path: "tool-call" | "tool-cancel", payload: unknown, t?: Translator): Promise<string | null> {
  const response = await fetch(`/api/remote/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.ok) return null;
  if (response.status === 409) return t ? t("项目所属设备不在线。") : "项目所属设备不在线。";
  const detail = (await response.json().catch(() => null)) as { error?: string } | null;
  return detail?.error ?? (t ? t("中转请求失败（{0}）。", { "0": response.status }) : `中转请求失败（${response.status}）。`);
}

/**
 * Registers this browser tab on demand on the account's relay (`/api/remote/events`) and lets it
 * run a project's workspace tools on the device that owns the project. Only the tool call crosses
 * devices; the LLM request and message persistence stay in the browser.
 */
export function useRemoteDevice(enabled: boolean) {
  const t = useTranslator();
  const translatorRef = useRef(t);
  useEffect(() => { translatorRef.current = t; }, [t]);
  const [connected, setConnected] = useState(false);
  const [devices, setDevices] = useState<string[]>([]);
  const deviceIdRef = useRef<string | null>(null);
  const pendingRef = useRef(new Map<string, Pending>());
  const controlId = useRef<string | null>(null);
  const controls = useRef(new Map<string, ControlPending>());
  const [controlReady, setControlReady] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const deviceId = loadDeviceId();
    deviceIdRef.current = deviceId;
    const pending = pendingRef.current;
    const settleAll = (message: string, only?: (entry: Pending) => boolean) => {
      for (const entry of [...pending.values()]) {
        if (!only || only(entry)) entry.settle(failure(message));
      }
    };

    const activeControls = controls.current;
    const disconnectControl = () => {
      controlId.current = null;
      setControlReady(false);
      for (const entry of activeControls.values()) {
        entry.reject(new Error(translatorRef.current("与中转服务的连接已断开。")));
      }
      activeControls.clear();
    };
    const source = new EventSource(`/api/remote/events?deviceId=${encodeURIComponent(deviceId)}&control=client`);
    source.addEventListener("controlReady", (event: MessageEvent<string>) => {
      const frame = JSON.parse(event.data) as { connectionId: string };
      controlId.current = frame.connectionId;
      setControlReady(true);
    });
    source.addEventListener("controlReply", (event: MessageEvent<string>) => {
      const frame = JSON.parse(event.data) as { id: string; done: boolean; payload: ControlEvent };
      const entry = activeControls.get(frame.id);
      if (!entry) return;
      if (frame.done) {
        activeControls.delete(frame.id);
        if (frame.payload.type === "Error") {
          entry.reject(new Error([frame.payload.message, frame.payload.detail].filter(Boolean).join(" ")));
        } else {
          entry.resolve(frame.payload);
        }
      } else {
        entry.update?.(frame.payload);
      }
    });
    source.onopen = () => setConnected(true);
    source.onerror = () => {
      disconnectControl();
      setConnected(false);
      setDevices([]);
      settleAll(translatorRef.current("与中转服务的连接已断开。"));
    };
    source.addEventListener("presence", (event) => {
      try {
        const online = (JSON.parse((event as MessageEvent<string>).data) as { devices?: string[] }).devices ?? [];
        setConnected(true);
        setDevices(online);
        settleAll(translatorRef.current("项目所属设备已离线。"), (entry) => !online.includes(entry.target));
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
      deviceIdRef.current = null;
      disconnectControl();
      settleAll(translatorRef.current("与中转服务的连接已断开。"));
      setConnected(false);
      setDevices([]);
    };
  }, [enabled]);

  const callTool = useCallback((request: RemoteToolRequest) => new Promise<RemoteToolResult>((resolve) => {
    const fromDeviceId = deviceIdRef.current;
    if (!fromDeviceId) {
      resolve(failure(t("尚未连接到中转服务。")));
      return;
    }
    const pending = pendingRef.current;
    const callId = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => settle(failure(t("已取消。")), true);
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
    timer = setTimeout(() => settle(failure(t("工具调用超时（10 分钟）。")), true), TOOL_TIMEOUT_MS);
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
    }, t).then(
      (error) => {
        if (error) settle(failure(error));
      },
      (error: unknown) => settle(failure(error instanceof Error ? error.message : t("中转请求失败。"))),
    );
  }), [t]);

  const controlRequest = useCallback((target: string, payload: unknown, update?: ControlPending["update"]) => {
    const id = crypto.randomUUID();
    const connectionId = controlId.current;
    const result = new Promise<ControlEvent>((resolve, reject) => {
      if (!connectionId) {
        reject(new Error(translatorRef.current("尚未连接到中转服务。")));
        return;
      }
      controls.current.set(id, { resolve, reject, update });
      void postControl({ kind: "request", connectionId, target, id, payload }).catch((error: Error) => {
        if (controls.current.delete(id)) {
          reject(error);
          void postControl({ kind: "signal", connectionId, id }).catch(() => undefined);
        }
      });
    });
    return { id, result };
  }, []);

  const controlSignal = useCallback(async (id: string, optionId?: string) => {
    const connectionId = controlId.current;
    if (connectionId) await postControl({ kind: "signal", connectionId, id, optionId });
  }, []);

  return { connected, devices, callTool, controlReady, controlRequest, controlSignal };
}
