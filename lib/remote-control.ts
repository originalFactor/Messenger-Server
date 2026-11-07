import { randomUUID } from "node:crypto";
import type { RemoteConnection } from "@/lib/remote-hub";

type Endpoint = {
  id: string;
  userId: string;
  sid: string;
  connection: RemoteConnection;
  role: "host" | "client";
  enabled: boolean;
  name: string;
};
type Lane = {
  client: Endpoint;
  host: Endpoint;
  clientId: string;
  hostId: string;
  timer: ReturnType<typeof setTimeout>;
};

class ControlRelay {
  private endpoints = new Map<string, Endpoint>();
  private lanes = new Map<string, Lane>();
  private replies = new Map<string, string>();

  register(userId: string, sid: string, role: Endpoint["role"], connection: RemoteConnection) {
    const connectionId = randomUUID();
    this.endpoints.set(connectionId, { id: connectionId, userId, sid, role, connection, enabled: false, name: "" });
    if (!connection.send("controlReady", { connectionId })) connection.close();
    return () => {
      const endpoint = this.endpoints.get(connectionId);
      this.endpoints.delete(connectionId);
      if (endpoint) this.closeLanes(endpoint);
    };
  }

  devices(userId: string) {
    return [...this.endpoints.values()]
      .filter((entry) => entry.userId === userId && entry.role === "host" && entry.enabled)
      .map(({ connection, name }) => ({ id: connection.deviceId, name }));
  }

  authenticate(userId: string, sid: string, connectionId: string) {
    const endpoint = this.endpoints.get(connectionId);
    return endpoint?.userId === userId && endpoint.sid === sid ? endpoint : null;
  }

  advertise(endpoint: Endpoint, enabled: boolean, name: string) {
    if (endpoint.role !== "host") return false;
    endpoint.enabled = enabled;
    endpoint.name = name;
    if (!enabled) this.closeLanes(endpoint);
    return true;
  }

  request(client: Endpoint, target: string, id: string, payload: unknown) {
    if (client.role !== "client") return 403;
    const host = [...this.endpoints.values()].find((entry) =>
      entry.userId === client.userId && entry.role === "host" &&
      entry.enabled && entry.connection.deviceId === target);
    if (!host) return 409;
    const key = this.key(client, id);
    if (this.lanes.has(key)) return 409;
    const lanes = [...this.lanes.values()];
    if (lanes.filter((lane) => lane.client === client).length >= 16 ||
        lanes.filter((lane) => lane.host === host).length >= 32) return 429;
    const timer = setTimeout(() => this.finish(key, "The control request timed out."), 30 * 60_000);
    const hostId = randomUUID();
    this.lanes.set(key, { client, host, clientId: id, hostId, timer });
    this.replies.set(hostId, key);
    if (this.send(host, "controlRequest", { id: hostId, payload })) return 202;
    this.remove(key);
    return 409;
  }

  reply(host: Endpoint, id: string, payload: unknown, done: boolean) {
    const key = this.replies.get(id);
    if (!key) return false;
    const lane = this.lanes.get(key);
    if (lane?.host !== host || !host.enabled) return false;
    if (done) this.remove(key);
    return this.send(lane.client, "controlReply", { id: lane.clientId, payload, done });
  }

  signal(client: Endpoint, id: string, optionId?: string) {
    const key = this.key(client, id);
    const lane = this.lanes.get(key);
    if (lane?.client !== client) return false;
    return this.send(lane.host, "controlSignal", { id: lane.hostId, optionId });
  }

  private key(endpoint: Endpoint, id: string) {
    return `${endpoint.id}/${id}`;
  }

  private send(endpoint: Endpoint, event: "controlRequest" | "controlReply" | "controlSignal", data: unknown) {
    if (endpoint.connection.send(event, data)) return true;
    endpoint.connection.close();
    return false;
  }

  private remove(key: string) {
    const lane = this.lanes.get(key);
    if (lane) {
      clearTimeout(lane.timer);
      this.replies.delete(lane.hostId);
    }
    this.lanes.delete(key);
    return lane;
  }

  private finish(key: string, message: string) {
    const lane = this.remove(key);
    if (!lane) return;
    this.send(lane.host, "controlSignal", { id: lane.hostId });
    this.send(lane.client, "controlReply", {
      id: lane.clientId, done: true, payload: { type: "Error", code: "device_unavailable", message },
    });
  }

  private closeLanes(endpoint: Endpoint) {
    for (const [key, lane] of this.lanes) {
      if (lane.client === endpoint || lane.host === endpoint) {
        this.finish(key, "The remote control connection ended.");
      }
    }
  }
}

declare global {
  var messengerControlRelay: ControlRelay | undefined;
}

export function controlRelay() {
  return globalThis.messengerControlRelay ??= new ControlRelay();
}
