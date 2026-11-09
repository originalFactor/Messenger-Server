import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { test } from "node:test";
import { startDevDiscovery, DISCOVERY_PORT, DISCOVERY_QUERY } from "../lib/dev-discovery.ts";
import { GET } from "../app/api/dev/discovery/route.ts";

test("discovery is development-only and advertises the actual HTTP port", async () => {
  const previousMode = process.env.NODE_ENV;
  const previousPort = process.env.PORT;
  const client = createSocket("udp4");
  try {
    process.env.NODE_ENV = "production";
    startDevDiscovery();
    assert.equal(globalThis.messengerDevDiscovery, undefined);
    assert.equal(GET().status, 404);

    process.env.NODE_ENV = "development";
    process.env.PORT = "3456";
    startDevDiscovery();
    const server = globalThis.messengerDevDiscovery;
    startDevDiscovery();
    assert.equal(globalThis.messengerDevDiscovery, server);
    await once(server, "listening");
    client.bind(0, "127.0.0.1");
    await once(client, "listening");
    const response = once(client, "message", { signal: AbortSignal.timeout(2000) });
    client.send(DISCOVERY_QUERY, DISCOVERY_PORT, "127.0.0.1");
    const [body] = await response;
    assert.deepEqual(JSON.parse(body.toString()), { service: "messenger-cloud", version: 1, port: 3456 });
    const identity = GET();
    assert.equal(identity.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await identity.json(), { service: "messenger-cloud", version: 1, development: true });
  } finally {
    client.close();
    globalThis.messengerDevDiscovery?.close();
    delete globalThis.messengerDevDiscovery;
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
});
