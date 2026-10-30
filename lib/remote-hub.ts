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

/**
 * 远程项目中转（`/api/remote/*`）。
 *
 * 一个账号的每台设备持有一条 SSE 长连接（`GET /api/remote/events`）；连接存在
 * 即「在线」。中转只做两件事：向该账号的所有连接广播「当前在线设备集合」
 * （`presence`），以及把 `toolCall` / `toolResult` / `toolCancel` 按
 * `targetDeviceId` 转发给目标设备的连接。载荷不落库、不解释——这也是它不需要
 * 集合和索引的原因。
 *
 * 状态保存在进程内存里（挂在 `globalThis` 上，热重载和多个路由 bundle 共享同一
 * 份），因此**要求单实例部署**——这正是 `compose.yaml` 的拓扑。扩成多实例前必须把
 * 这里换成跨进程的发布订阅（例如 MongoDB change stream）：否则两台设备落在不同
 * 实例上时互相看不到在线，远程项目会一直显示不可用。
 *
 * 为什么按 `userId` 隔离：所有查找都以会话里的 `sub` 为第一级键，设备 ID 只在
 * 账号内唯一；一个账号永远无法向另一个账号的设备投递。
 */

export type RemoteEventName = "presence" | "toolCall" | "toolResult" | "toolCancel";

export interface RemoteConnection {
  readonly deviceId: string;
  /** 写入一帧 SSE；连接已关闭或积压过多时返回 `false`。 */
  send(event: RemoteEventName, data: unknown): boolean;
  /** 关闭这条连接（幂等）。 */
  close(): void;
}

class RemoteHub {
  private readonly users = new Map<string, Map<string, RemoteConnection>>();

  /** 登记一条连接；同一设备的旧连接被顶替（设备重连时旧连接可能还没被发现断开）。 */
  register(userId: string, connection: RemoteConnection): void {
    let devices = this.users.get(userId);
    if (!devices) {
      devices = new Map();
      this.users.set(userId, devices);
    }
    const previous = devices.get(connection.deviceId);
    devices.set(connection.deviceId, connection);
    previous?.close();
    this.broadcastPresence(userId);
  }

  /** 只在登记的仍是这条连接时才移除：被顶替的旧连接断开不能把新连接踢下线。 */
  unregister(userId: string, connection: RemoteConnection): void {
    const devices = this.users.get(userId);
    if (!devices || devices.get(connection.deviceId) !== connection) {
      return;
    }
    devices.delete(connection.deviceId);
    if (devices.size === 0) {
      this.users.delete(userId);
    }
    this.broadcastPresence(userId);
  }

  presence(userId: string): string[] {
    return [...(this.users.get(userId)?.keys() ?? [])].sort();
  }

  isOnline(userId: string, deviceId: string): boolean {
    return this.users.get(userId)?.has(deviceId) ?? false;
  }

  /** 向目标设备投递；目标不在线或写入失败返回 `false`。 */
  deliver(userId: string, targetDeviceId: string, event: RemoteEventName, data: unknown): boolean {
    const connection = this.users.get(userId)?.get(targetDeviceId);
    if (!connection) {
      return false;
    }
    if (!connection.send(event, data)) {
      this.unregister(userId, connection);
      connection.close();
      return false;
    }
    return true;
  }

  /** 关闭账号的全部连接（注销账号、会话失效时用）。 */
  closeUser(userId: string): void {
    for (const connection of [...(this.users.get(userId)?.values() ?? [])]) {
      connection.close();
      this.unregister(userId, connection);
    }
  }

  private broadcastPresence(userId: string): void {
    const devices = this.users.get(userId);
    if (!devices) {
      return;
    }
    const payload = { devices: this.presence(userId) };
    for (const connection of [...devices.values()]) {
      if (!connection.send("presence", payload)) {
        // 写入失败的连接视为已断开；递归广播会再通知剩下的设备。
        devices.delete(connection.deviceId);
        connection.close();
        if (devices.size === 0) {
          this.users.delete(userId);
        } else {
          this.broadcastPresence(userId);
        }
        return;
      }
    }
  }
}

declare global {
  var messengerRemoteHub: RemoteHub | undefined;
}

export function getRemoteHub(): RemoteHub {
  globalThis.messengerRemoteHub ??= new RemoteHub();
  return globalThis.messengerRemoteHub;
}

export type { RemoteHub };
