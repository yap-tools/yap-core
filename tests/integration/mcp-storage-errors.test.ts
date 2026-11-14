/**
 * A storage error that is not a domain error (an index or constraint the
 * database enforces) must not reach an MCP caller as the raw database message,
 * which names tables, indexes and stored values. The caller gets a bare
 * `internal` error; the detail goes to the operator log.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import type { Db } from "../../src/db/index.js";
import { createLogger } from "../../src/logger.js";
import { describeEachAdapter } from "../helpers/adapters.js";
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
    await rawSql(db, "CREATE UNIQUE INDEX test_one_value_per_item ON item_values (item_id)");
    mcp = await connectMcp(app.baseUrl, key);
  });

  afterAll(async () => {
    await mcp?.close();
    // The Postgres test database is shared across suites: drop the index.
    if (app) await rawSql(app.db, "DROP INDEX IF EXISTS test_one_value_per_item");
    await app?.stop();
  });

  async function rawSql(db: Db, statement: string): Promise<void> {
    const client = db.client as unknown as { run?(q: unknown): unknown; execute?(q: unknown): Promise<unknown> };
    if (adapter.dialect === "pg") await client.execute!(sql.raw(statement));
    else client.run!(sql.raw(statement));
  }

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
});
