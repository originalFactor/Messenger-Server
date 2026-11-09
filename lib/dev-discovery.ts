import { createSocket, type Socket } from "node:dgram";

export const DISCOVERY_PORT = 53319;
export const DISCOVERY_QUERY = "messenger-cloud-discover-v1";

const state = globalThis as typeof globalThis & { messengerDevDiscovery?: Socket };

/** Development only; no account, session or machine information is advertised. */
export function startDevDiscovery() {
  if (process.env.NODE_ENV !== "development" || state.messengerDevDiscovery) return;
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  state.messengerDevDiscovery = socket;
  socket.on("error", (error) => {
    console.warn("[dev-discovery]", error.message);
    socket.close();
    delete state.messengerDevDiscovery;
  });
  socket.on("message", (message, peer) => {
    if (message.toString() !== DISCOVERY_QUERY) return;
    socket.send(JSON.stringify({ service: "messenger-cloud", version: 1, port }), peer.port, peer.address);
  });
  socket.bind(DISCOVERY_PORT, "0.0.0.0", () => socket.unref());
}
