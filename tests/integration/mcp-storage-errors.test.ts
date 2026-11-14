/**
 * A storage error that is not a domain error (an index or constraint the
 * database enforces) must not reach an MCP caller as the raw database message,
 * which names tables, indexes and stored values. The caller gets a bare
 * `internal` error; the detail goes to the operator log.
 */
import { afterAll, beforeAll, expect, it } from "vitest";

import { createLogger } from "../../src/logger.js";
import { describeEachAdapter, rawExec } from "../helpers/adapters.js";
import { apiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

describeEachAdapter("MCP storage errors", (adapter) => {
  let app: TestApp;
  let mcp: McpTestClient;
  let spaceId: string;
  let bundleId: string;
  const logged: unknown[][] = [];

  beforeAll(async () => {
    const db = await adapter.makeDb();
    const quiet = () => {};
    const logger = createLogger({ debug: quiet, info: quiet, log: quiet, warn: quiet, error: (...args) => logged.push(args) });
    app = await bootTestApp({}, db, logger);
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const key = (await sysadmin.post("/v1/users", { name: "Alice" })).body.initialKey.key;
    const rest = apiClient(app.baseUrl, key);
    spaceId = (await rest.post("/v1/spaces", { name: "S" })).body.id;
    bundleId = (
      await rest.post(`/v1/spaces/${spaceId}/bundles`, {
        name: "b",
        itemTypes: [{ name: "doc", properties: [{ name: "tags", datatype: "text", multi: true }] }],
      })
    ).body.id;
    // A constraint Core does not know about: at most one value row per item.
    // Any item with two tags now fails inside the database, not in validation.
    await rawExec(db, "CREATE UNIQUE INDEX test_one_value_per_item ON item_values (item_id)");
    // And at most one space per name, for a first-tier tool to trip over.
    await rawExec(db, "CREATE UNIQUE INDEX test_one_space_per_name ON spaces (name)");
    mcp = await connectMcp(app.baseUrl, key);
  });

  afterAll(async () => {
    await mcp?.close();
    // The Postgres test database is shared across suites: drop the index.
    if (app) {
      await rawExec(app.db, "DROP INDEX IF EXISTS test_one_value_per_item");
      await rawExec(app.db, "DROP INDEX IF EXISTS test_one_space_per_name");
    }
    await app?.stop();
  });

  it("reports a bare internal error and logs the detail", async () => {
    const out = await mcp.call("call", {
      space_id: spaceId,
      calls: [{ tool: "create_items", bundle_id: bundleId, params: { item_type: "doc", items: [{ tags: ["a", "b"] }] } }],
    });
    const result = out.results[0];
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: "internal", message: "internal error" });
    expect(JSON.stringify(out)).not.toMatch(/item_values|test_one_value_per_item|duplicate|UNIQUE/i);
    expect(logged.some((args) => args[0] === "unhandled MCP call error")).toBe(true);
  });

  it("does the same for a first-tier tool", async () => {
    // "S" already exists (made in beforeAll), so the raw index refuses this.
    const result = await mcp.callRaw("space_create", { name: "S" });
    expect(result.isError).toBe(true);
    const text = result.content.map((c: { text: string }) => c.text).join("\n");
    expect(text).toBe("internal: internal error");
    expect(logged.some((args) => args[0] === "unhandled MCP tool error")).toBe(true);
  });
});
