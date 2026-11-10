import assert from "node:assert/strict";
import { test } from "node:test";
import { integrationCatalog } from "../lib/integration-catalog.ts";

test("ACP store templates use stdio adapters and contain no local credentials", () => {
  assert.deepEqual(integrationCatalog.acp.map(row => row.name), ["Codex", "Claude Code", "OpenCode"]);
  for (const row of integrationCatalog.acp) {
    assert.ok(row.description.length > 0);
    assert.ok(row.command.length > 0);
    assert.ok(Array.isArray(row.args));
    assert.deepEqual(row.env, {});
    assert.equal(row.cwd, null);
    assert.equal(row.enabled, false);
    assert.ok(!["npm", "npx", "yarn", "bun"].includes(row.command));
  }
  assert.deepEqual(integrationCatalog.acp.find(row => row.id === "opencode").args, ["acp"]);
});

test("MCP store imports start disabled so directory scope can be configured", () => {
  for (const row of integrationCatalog.mcp) {
    assert.equal(row.isEnabled, false);
    assert.equal(row.transportType, "STDIO");
    assert.equal(row.command, "pnpm");
    assert.equal(row.args[0], "dlx");
  }
});
