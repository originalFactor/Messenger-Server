import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { controlRelay } from "../lib/remote-control.ts";

test("control requests, signals and replies belong to live connection instances", () => {
  const relay = controlRelay();
  const cleanup = [];
  function connect(user, sid, role, deviceId) {
    const events = [];
    let disconnect;
    const connection = {
      deviceId,
      send(name, data) {
        events.push({ name, data });
        return true;
      },
      close() { disconnect?.(); },
    };
    disconnect = relay.register(user, sid, role, connection);
    cleanup.push(disconnect);
    const id = events.shift().data.connectionId;
    return { id, events, disconnect, endpoint: relay.authenticate(user, sid, id) };
  }

  const owner = connect("alice", "desktop-session", "host", "desktop");
  const browser = connect("alice", "browser-session", "client", "tab-one");
  const otherTab = connect("alice", "browser-session", "client", "tab-two");
  const otherUser = connect("bob", "bob-session", "client", "tab-one");
  const otherHost = connect("alice", "second-desktop-session", "host", "desktop-2");
  const clientId = randomUUID();
  try {
    assert.deepEqual(relay.devices("alice"), []);
    assert.equal(relay.request(browser.endpoint, "desktop", clientId, {}), 409);
    assert.equal(relay.advertise(owner.endpoint, true, "Office"), true);
    assert.deepEqual(relay.devices("alice"), [{ id: "desktop", name: "Office" }]);
    assert.deepEqual(relay.devices("bob"), []);
    assert.equal(relay.authenticate("alice", "wrong-sid", owner.id), null);
    assert.equal(relay.request(otherUser.endpoint, "desktop", clientId, {}), 409);

    assert.equal(relay.request(browser.endpoint, "desktop", clientId, { action: "catalog" }), 202);
    const { id: hostId } = owner.events.at(-1).data;
    assert.notEqual(hostId, clientId);
    assert.equal(relay.signal(otherTab.endpoint, clientId, "allow"), false);
    assert.equal(relay.reply(otherHost.endpoint, hostId, { type: "Finished" }, true), false);
    assert.equal(relay.signal(browser.endpoint, clientId, "allow"), true);
    assert.deepEqual(owner.events.at(-1).data, { id: hostId, optionId: "allow" });
    assert.equal(relay.reply(owner.endpoint, hostId, { type: "Finished" }, true), true);
    assert.deepEqual(browser.events.at(-1).data, { id: clientId, done: true, payload: { type: "Finished" } });

    assert.equal(relay.request(browser.endpoint, "desktop", clientId, {}), 202);
    const nextHostId = owner.events.at(-1).data.id;
    assert.notEqual(nextHostId, hostId);
    assert.equal(relay.reply(owner.endpoint, hostId, {}, true), false);
    browser.disconnect();
    assert.equal(relay.authenticate("alice", "browser-session", browser.id), null);
    assert.equal(owner.events.at(-1).name, "controlSignal");
    assert.equal(owner.events.at(-1).data.id, nextHostId);
    assert.equal(relay.reply(owner.endpoint, nextHostId, {}, true), false);
  } finally {
    cleanup.forEach((disconnect) => disconnect());
  }
});
