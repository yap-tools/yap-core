/**
 * External drivers: the instance's drivers/ directory is the install surface.
 * A driver is a folder with a package.json declaring `yap.driverApi` and an
 * entry module default-exporting a definition; the loader registers it before
 * the server is built, so an operator-installed driver is authorable and
 * runnable exactly like a built-in one.
 *
 * The other half of this suite is the failure mode: a driver the operator
 * installed but that cannot be loaded takes the boot down with a message
 * naming the folder. Silently skipping it would leave services referencing a
 * driver that is "not installed" with no explanation anywhere.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadExternalDrivers } from "../../src/core/drivers/load.js";
import { DriverRegistry } from "../../src/core/drivers/registry.js";
import { createLogger } from "../../src/logger.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/driver-echo", import.meta.url));

const quiet = createLogger({ debug() {}, info() {}, log() {}, warn() {}, error() {} });

/** A fresh drivers/ directory holding a copy of the echo fixture. */
function driversDirWithEcho(folder = "driver-echo"): string {
  const dir = mkdtempSync(join(tmpdir(), "yap-drivers-"));
  cpSync(FIXTURE, join(dir, folder), { recursive: true });
  return dir;
}

/** Rewrites one field of a copied fixture's package.json. */
function patchPackageJson(dir: string, folder: string, mutate: (pkg: any) => void): void {
  const path = join(dir, folder, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  mutate(pkg);
  writeFileSync(path, JSON.stringify(pkg, null, 2));
}

describe("external driver loading", () => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceMcp: McpTestClient;
  let spaceId: string;
  let bundleId: string;

  beforeAll(async () => {
    app = await bootTestApp({ YAP_DRIVERS_DIR: driversDirWithEcho() });
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    aliceMcp = await connectMcp(app.baseUrl, a.body.initialKey.key);
    spaceId = (await alice.post("/v1/spaces", { name: "Installed" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "echoes" })).body.id;
  });

  afterAll(async () => {
    await aliceMcp.close();
    await app.stop();
  });

  it("authors a service on the installed driver and runs it over MCP", async () => {
    const created = await alice.post(`/v1/bundles/${bundleId}/services`, {
      name: "echo-back",
      driver: "echo",
      config: {},
    });
    expect(created.status).toBe(201);
    expect(created.body.driver).toBe("echo");
    expect(created.body.actions).toEqual([
      {
        name: "echo",
        description: "Echoes the supplied message.",
        params: [{ name: "message", description: "What to echo back", required: true }],
      },
      {
        name: "shout",
        description: "Echoes the supplied message in upper case.",
        params: [{ name: "message", description: "What to shout back", required: true }],
      },
    ]);

    const res = await aliceMcp.call("call", {
      space_id: spaceId,
      calls: [
        {
          bundle_id: bundleId,
          tool: "run_service",
          params: { id: "echo-back", action: "echo", params: { message: "hi" }, wait_ms: 5000 },
        },
      ],
    });
    const result = res.results[0];
    expect(result.ok).toBe(true);
    expect(result.result.status).toBe("succeeded");
    expect(result.result.result).toEqual({ echoed: "hi" });
  });

  it("restricts a service to some of the driver's actions, over REST and MCP alike", async () => {
    const created = await alice.post(`/v1/bundles/${bundleId}/services`, {
      name: "shouter",
      driver: "echo",
      actions: ["shout"],
      config: {},
    });
    expect(created.status).toBe(201);
    expect(created.body.actions.map((a: any) => a.name)).toEqual(["shout"]);

    // REST listing and load_bundle both show only the allowed action; the
    // disabled one is not discoverable from either.
    const listed = (await alice.get(`/v1/bundles/${bundleId}/services`)).body.data.find((s: any) => s.name === "shouter");
    expect(listed.actions.map((a: any) => a.name)).toEqual(["shout"]);
    const loaded = await aliceMcp.call("load_bundle", { bundle_ids: [bundleId] });
    const viaMcp = loaded.bundles[0].services.find((s: any) => s.name === "shouter");
    expect(viaMcp.actions.map((a: any) => a.name)).toEqual(["shout"]);
    expect(JSON.stringify(viaMcp.actions)).not.toContain("echo");

    const call = (params: Record<string, unknown>) =>
      aliceMcp
        .call("call", {
          space_id: spaceId,
          calls: [{ bundle_id: bundleId, tool: "run_service", params: { id: "shouter", wait_ms: 5000, ...params } }],
        })
        .then((res) => res.results[0]);

    // One allowed action: it is the default, no `action` needed.
    const implicit = await call({ params: { message: "hi" } });
    expect(implicit.ok).toBe(true);
    expect(implicit.result.action).toBe("shout");
    expect(implicit.result.result).toEqual({ shouted: "HI" });

    // The disabled action is unknown, and the hint lists only what is allowed.
    const disabled = await call({ action: "echo", params: { message: "hi" } });
    expect(disabled.ok).toBe(false);
    expect(disabled.error.message).toBe('unknown action "echo" for service "shouter" (available: shout)');
    const viaRest = await alice.post(`/v1/services/${created.body.id}/run`, { action: "echo", params: { message: "hi" } });
    expect(viaRest.status).toBe(400);
    expect(viaRest.body.error.message).toBe('unknown action "echo" for service "shouter" (available: shout)');

    // Widening the allowlist brings the default question back.
    const widened = await alice.patch(`/v1/services/${created.body.id}`, { actions: ["echo", "shout"] });
    expect(widened.body.actions.map((a: any) => a.name)).toEqual(["echo", "shout"]);
    const ambiguous = await call({ params: { message: "hi" } });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error.message).toMatch(/needs an action — one of: echo, shout/);
  });

  it("built-in drivers stay installed alongside it", async () => {
    const res = await alice.post(`/v1/bundles/${bundleId}/services`, {
      name: "unknown-driver",
      driver: "nope",
      config: {},
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/installed: echo, http, mail/);
  });
});

describe("reading installed drivers and their config schemas", () => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceMcp: McpTestClient;

  beforeAll(async () => {
    app = await bootTestApp({ YAP_DRIVERS_DIR: driversDirWithEcho() });
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    aliceMcp = await connectMcp(app.baseUrl, a.body.initialKey.key);
  });

  afterAll(async () => {
    await aliceMcp.close();
    await app.stop();
  });

  it("lists every installed driver over REST, with schema and secret paths where published", async () => {
    const res = await alice.get("/v1/drivers");
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.data.map((d: any) => [d.name, d]));
    expect(Object.keys(byName)).toEqual(["echo", "http", "mail"]);

    // A driver without a schema is listed as it is: configSchema null.
    expect(byName.echo.configSchema).toBeNull();
    expect(byName.echo.configDoc).toBe("No configuration: {}");
    expect(byName.echo.actions.map((a: any) => a.name)).toEqual(["echo", "shout"]);
    expect(byName.echo.reads).toEqual({ files: false, items: false });

    expect(byName.mail.configSchema.jsonSchema.type).toBe("object");
    expect(byName.mail.configSchema.secrets.map((s: any) => s.path)).toEqual([
      "pass",
      "oauth2.client_secret",
      "oauth2.refresh_token",
    ]);
    expect(byName.http.configSchema.secrets.map((s: any) => s.path)).toEqual(["headers.*"]);
    for (const secret of [...byName.mail.configSchema.secrets, ...byName.http.configSchema.secrets]) {
      expect(secret.label).toEqual(expect.any(String));
    }
  });

  it("reads one driver by name, 404 for an unknown one", async () => {
    const mail = await alice.get("/v1/drivers/mail");
    expect(mail.status).toBe(200);
    expect(mail.body.name).toBe("mail");
    expect(mail.body.configSchema.secrets).toHaveLength(3);
    expect((await alice.get("/v1/drivers/nope")).status).toBe(404);
  });

  it("needs a credential; the sysadmin key may read it too", async () => {
    expect((await apiClient(app.baseUrl).get("/v1/drivers")).status).toBe(401);
    expect((await apiClient(app.baseUrl, "not-a-key").get("/v1/drivers")).status).toBe(401);
    const asSysadmin = await apiClient(app.baseUrl, TEST_SYSADMIN_KEY).get("/v1/drivers");
    expect(asSysadmin.status).toBe(200);
    expect(asSysadmin.body.data).toHaveLength(3);
  });

  it("serves the same view over MCP list_drivers, optionally narrowed by name", async () => {
    const rest = (await alice.get("/v1/drivers")).body;
    expect(await aliceMcp.call("list_drivers")).toEqual(rest);
    const narrowed = await aliceMcp.call("list_drivers", { names: ["mail"] });
    expect(narrowed.data.map((d: any) => d.name)).toEqual(["mail"]);
    expect(narrowed.data[0].configSchema.secrets.map((s: any) => s.path)).toContain("pass");
    const unknown: any = await aliceMcp.callRaw("list_drivers", { names: ["nope"] });
    expect(unknown.isError).toBe(true);
  });
});

describe("driver loading failures", () => {
  it("fails the boot when a driver declares a different driver api", async () => {
    const dir = driversDirWithEcho();
    patchPackageJson(dir, "driver-echo", (pkg) => {
      pkg.yap.driverApi = 2;
    });
    await expect(bootTestApp({ YAP_DRIVERS_DIR: dir })).rejects.toThrow(
      /driver-echo.*driverApi 2.*supports driver api 1|driver api 1.*driver-echo/s,
    );
  });

  it("names the folder when the entry module cannot be imported", async () => {
    const dir = driversDirWithEcho();
    writeFileSync(join(dir, "driver-echo", "index.js"), "export default {,,,\n");
    const registry = new DriverRegistry();
    await expect(loadExternalDrivers(dir, registry, quiet)).rejects.toThrow(/driver-echo/);
    expect(registry.list()).toEqual([]);
  });

  it("rejects a driver whose default export is not a valid definition", async () => {
    const dir = driversDirWithEcho();
    writeFileSync(join(dir, "driver-echo", "index.js"), "export default { name: 'echo' };\n");
    const registry = new DriverRegistry();
    await expect(loadExternalDrivers(dir, registry, quiet)).rejects.toThrow(/driver-echo/);
  });

  it("requires the driverApi declaration to be present at all", async () => {
    const dir = driversDirWithEcho();
    patchPackageJson(dir, "driver-echo", (pkg) => {
      delete pkg.yap;
    });
    await expect(loadExternalDrivers(dir, new DriverRegistry(), quiet)).rejects.toThrow(
      /driver-echo.*yap\.driverApi/s,
    );
  });

  it("ignores a directory without a package.json", async () => {
    const dir = driversDirWithEcho();
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "README.md"), "not a driver\n");
    writeFileSync(join(dir, "loose-file.js"), "not a driver either\n");
    const registry = new DriverRegistry();
    await loadExternalDrivers(dir, registry, quiet);
    expect(registry.list().map((d) => d.name)).toEqual(["echo"]);
  });

  it("is a no-op when the drivers directory does not exist", async () => {
    const registry = new DriverRegistry();
    await loadExternalDrivers(join(mkdtempSync(join(tmpdir(), "yap-nodrivers-")), "drivers"), registry, quiet);
    expect(registry.list()).toEqual([]);
  });

  it("uses package.json main as the entry module", async () => {
    const dir = driversDirWithEcho();
    cpSync(join(dir, "driver-echo", "index.js"), join(dir, "driver-echo", "driver.js"));
    writeFileSync(join(dir, "driver-echo", "index.js"), "throw new Error('wrong entry');\n");
    patchPackageJson(dir, "driver-echo", (pkg) => {
      pkg.main = "driver.js";
    });
    const registry = new DriverRegistry();
    await loadExternalDrivers(dir, registry, quiet);
    expect(registry.get("echo").description).toBe("Echoes a message back.");
  });
});
