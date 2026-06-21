/**
 * Agent runtimes: the sysadmin REST surface for instance-level model
 * credentials, and the `yap agent-runtime` CLI driving it (authorize stores a
 * captured blob; refresh/status/revoke wrap the endpoints). The mock runtime
 * stands in for a real provider.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cmdAgentRuntime } from "../../src/cli/agents.js";
import type { Target } from "../../src/cli/target.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";

describeEachAdapter("agent runtimes", (adapter) => {
  let app: TestApp;
  let sysadmin: ApiClient;
  let alice: ApiClient;
  let target: Target;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    app = await bootTestApp({}, await adapter.makeDb());
    sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    target = {
      baseUrl: app.baseUrl,
      remote: false,
      userKey: () => a.body.initialKey.key,
      sysKey: () => TEST_SYSADMIN_KEY,
    };
  });

  afterAll(async () => {
    await app.stop();
    vi.restoreAllMocks();
  });

  it("lists built-in runtimes (sysadmin only) with the mock initially uncredentialed", async () => {
    expect((await alice.get("/v1/agent-runtimes")).status).toBe(401); // not sysadmin
    const listed = await sysadmin.get("/v1/agent-runtimes");
    expect(listed.status).toBe(200);
    const mock = listed.body.data.find((r: any) => r.name === "mock");
    expect(mock).toBeTruthy();
    expect(mock.status).toBe("absent");
  });

  it("CLI authorize → refresh → revoke drives the credential lifecycle", async () => {
    const mockStatus = async () =>
      (await sysadmin.get("/v1/agent-runtimes")).body.data.find((r: any) => r.name === "mock").status;

    await cmdAgentRuntime(target, ".", ["mock", "authorize"]);
    expect(await mockStatus()).toBe("active");

    await cmdAgentRuntime(target, ".", ["mock", "refresh"]);
    expect(await mockStatus()).toBe("active");

    await cmdAgentRuntime(target, ".", ["mock", "revoke"]);
    expect(await mockStatus()).toBe("absent");
  });

  it("rejects storing a credential for an unknown runtime", async () => {
    const res = await sysadmin.put("/v1/agent-runtimes/nonesuch/credential", { blob: { x: 1 } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/unknown agent runtime/);
  });

  it("refresh on an absent credential is a 404", async () => {
    const res = await sysadmin.post("/v1/agent-runtimes/mock/refresh", {});
    expect(res.status).toBe(404);
  });
});
