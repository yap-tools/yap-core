/**
 * The four acceptance scenarios from the build brief. Scenario 4
 * (portability) is the test matrix itself: this whole file — like every
 * integration suite — runs unmodified against SQLite and, when
 * YAP_TEST_PG_URL is set (CI always sets it), against Postgres.
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveCapability } from "../../src/core/capabilities.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, getFreePort, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

describeEachAdapter("acceptance", (adapter) => {
  let app: TestApp;
  let operator: ApiClient;
  let agentKey: string;
  let agent: McpTestClient;
  let agentUserId: string;
  let workSpaceId: string;
  let todosBundleId: string;
  let target: Server;
  let targetPort: number;

  beforeAll(async () => {
    targetPort = await getFreePort();
    target = createServer((_req, res) => res.writeHead(200).end("fired"));
    await new Promise<void>((resolve) => target.listen(targetPort, "127.0.0.1", resolve));

    app = await bootTestApp(
      { YAP_DOWNLOAD_TTL_SECONDS: "2", YAP_HOOK_ALLOW_HOSTS: "127.0.0.1" },
      await adapter.makeDb(),
    );
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);

    // Seed: an operator-owned space holding a todos bundle with open items.
    const op = await sysadmin.post("/v1/users", { name: "Operator" });
    operator = apiClient(app.baseUrl, op.body.initialKey.key);
    workSpaceId = (
      await operator.post("/v1/spaces", {
        name: "Team Work",
        description: "Day-to-day team execution",
        keywords: "tasks, todos, work tracking",
      })
    ).body.id;
    todosBundleId = (
      await operator.post(`/v1/spaces/${workSpaceId}/bundles`, {
        name: "todos",
        description: "The team's todo list",
        docs: [{ name: "instructions", content: "Items of type todo carry title and status (open|done).", autoload: true }],
        itemTypes: [
          {
            name: "todo",
            properties: [
              { name: "title", datatype: "text", required: true },
              { name: "status", datatype: "text", required: true },
            ],
          },
        ],
      })
    ).body.id;
    await operator.post(`/v1/bundles/${todosBundleId}/items`, {
      itemType: "todo",
      items: [
        { title: "Fix the login bug", status: "open" },
        { title: "Release v2", status: "done" },
        { title: "Write onboarding docs", status: "open" },
      ],
    });

    // The connecting agent acts as a separate user granted into the space.
    const ag = await sysadmin.post("/v1/users", { name: "Agent" });
    agentKey = ag.body.initialKey.key;
    agentUserId = ag.body.user.id;
    await operator.post(`/v1/spaces/${workSpaceId}/grants`, {
      userId: agentUserId,
      capabilities: ["read_items", "edit_items", "read_files", "edit_files", "fire_hooks"],
      effect: "allow",
    });
    agent = await connectMcp(app.baseUrl, agentKey);
  });

  afterAll(async () => {
    await agent.close();
    await app.stop();
    await new Promise<void>((resolve, reject) => target.close((e) => (e ? reject(e) : resolve())));
  });

  it("1. Discovery end-to-end: resolves 'show me open todos' unaided", async () => {
    // load → match intent against space metadata without descending.
    const loaded = await agent.call("load");
    const candidates = loaded.spaces.filter((s: any) =>
      /todo|task/i.test(`${s.name} ${s.description} ${s.keywords}`),
    );
    expect(candidates).toHaveLength(1);
    const space = candidates[0];
    expect(space.id).toBe(workSpaceId);
    expect(space.role).toContain("read_items");

    // load_space → pick the bundle likely to hold the answer.
    const spaceDetail = await agent.call("load_space", { space_id: space.id });
    const bundle = spaceDetail.bundles.find((b: any) => /todo/i.test(`${b.name} ${b.description}`));
    expect(bundle.id).toBe(todosBundleId);

    // load_bundle → binding docs + the schema that makes the query correct.
    const bundleDetail = await agent.call("load_bundle", { bundle_ids: [bundle.id] });
    const schema = bundleDetail.bundles[0];
    expect(schema.docs.autoloaded[0].content).toContain("status");
    const todoType = schema.item_types.find((t: any) => t.name === "todo");
    expect(todoType.properties.some((p: any) => p.name === "status")).toBe(true);

    // call(query_items, status eq open) → the open items.
    const result = await agent.call("call", {
      space_id: space.id,
      calls: [
        {
          bundle_id: bundle.id,
          tool: "query_items",
          params: { item_type: "todo", filters: [{ property: "status", op: "eq", value: "open" }] },
        },
      ],
    });
    expect(result.results[0].ok).toBe(true);
    expect(result.results[0].result.data.map((i: any) => i.values.title).sort()).toEqual([
      "Fix the login bug",
      "Write onboarding docs",
    ]);
  });

  it("2. File round-trip, headless: request → upload → complete → show_file; link dies at TTL", async () => {
    const callOne = async (tool: string, params: Record<string, unknown>) => {
      const res = await agent.call("call", {
        space_id: workSpaceId,
        calls: [{ bundle_id: todosBundleId, tool, params }],
      });
      return res.results[0];
    };

    const requested = await callOne("upload_request", { name: "notes.txt", mime_type: "text/plain" });
    expect(requested.ok).toBe(true);

    const put = await fetch(requested.result.upload_url, { method: "PUT", body: "acceptance bytes" });
    expect(put.status).toBe(200);

    const completed = await callOne("upload_complete", { file_id: requested.result.file_id });
    expect(completed.ok).toBe(true);
    expect(completed.result.size).toBe(16);

    const shown = await callOne("show_file", { ref: `file://${requested.result.file_id}` });
    expect(shown.ok).toBe(true);
    const download = await fetch(shown.result.url);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("acceptance bytes");

    await new Promise((r) => setTimeout(r, 2300));
    expect((await fetch(shown.result.url)).status).toBe(401); // TTL of 2s in this app
  });

  it("3. Permission override: space-level fire_hooks, bundle-level deny — both outcomes row-identifiable", async () => {
    // Two bundles with hooks; the agent's space grant already includes fire_hooks.
    const sensitiveId = (
      await operator.post(`/v1/spaces/${workSpaceId}/bundles`, { name: "sensitive" })
    ).body.id;
    const siblingId = (
      await operator.post(`/v1/spaces/${workSpaceId}/bundles`, { name: "harmless" })
    ).body.id;
    for (const [bundleId, hookName] of [
      [sensitiveId, "danger"],
      [siblingId, "ping"],
    ] as const) {
      await operator.post(`/v1/bundles/${bundleId}/hooks`, {
        name: hookName,
        transport: { url: `http://127.0.0.1:${targetPort}/${hookName}`, method: "GET" },
      });
    }
    const deny = await operator.post(`/v1/bundles/${sensitiveId}/grants`, {
      userId: agentUserId,
      capabilities: ["fire_hooks"],
      effect: "deny",
    });
    const denyRowId = deny.body.data[0].id;

    const fire = async (bundleId: string, hook: string) => {
      const res = await agent.call("call", {
        space_id: workSpaceId,
        calls: [{ bundle_id: bundleId, tool: "fire_hook", params: { hook } }],
      });
      return res.results[0];
    };

    // Blocked on the denied bundle — the deciding row is the bundle-level deny.
    const blocked = await fire(sensitiveId, "danger");
    expect(blocked.ok).toBe(false);
    expect(blocked.error.code).toBe("forbidden");
    expect(blocked.error.details.decidedBy).toEqual({ grantId: denyRowId, level: "bundle", effect: "deny" });

    // Fires on the sibling under the space baseline.
    const allowed = await fire(siblingId, "ping");
    expect(allowed.ok).toBe(true);
    expect(allowed.result.status).toBe(200);

    // The allow outcome's deciding row is identifiable too: the space-level allow.
    const spaceRows = (await operator.get(`/v1/spaces/${workSpaceId}/grants`)).body.data;
    const spaceAllow = spaceRows.find(
      (g: any) => g.userId === agentUserId && g.capability === "fire_hooks" && g.effect === "allow",
    );
    const space = { id: workSpaceId, ownerId: "n/a", personal: 0 };
    const decision = await resolveCapability(app.db, agentUserId, "fire_hooks", {
      space,
      bundleId: siblingId,
    });
    expect(decision).toEqual({
      allowed: true,
      decidedBy: { grantId: spaceAllow.id, level: "space", effect: "allow" },
    });
  });

  it("4. Portability: this suite is running against the adapter matrix unmodified", () => {
    // The describeEachAdapter wrapper *is* the scenario: identical code, both
    // adapters. Assert which adapter this instance ran on for the record.
    expect(["sqlite", "pg"]).toContain(adapter.dialect);
  });
});
