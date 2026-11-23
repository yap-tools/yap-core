/**
 * `yap user create`: prints the new user's key once and saves it as the CLI
 * credential only with --save (never over an existing one).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readCredentials, writeCredentials } from "../../src/cli/credentials.js";
import { cmdUserCreate } from "../../src/cli/resources.js";
import type { Target } from "../../src/cli/target.js";
import { credentialsPath } from "../../src/instance/layout.js";

let server: Server;
let target: Target;
let dir: string;
let out: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "yap-user-create-"));
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = 201;
    res.end(
      JSON.stringify({
        user: { id: "u1", name: "bea" },
        personalSpaceId: "s1",
        initialKey: { key: "yk_new" },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  target = {
    baseUrl: `http://127.0.0.1:${port}`,
    remote: false,
    userKey: () => "unused",
    sysKey: () => "yap_sys",
  };
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

describe("cmdUserCreate", () => {
  it("prints the key and saves nothing by default", async () => {
    await cmdUserCreate(target, dir, ["bea"]);
    expect(existsSync(credentialsPath(dir))).toBe(false);
    const text = out.join("\n");
    expect(text).toContain("yk_new");
    expect(text).toContain("Not saved");
    expect(text).toContain("no credential yet");
  });

  it("says who the CLI still acts as when a credential exists", async () => {
    writeCredentials(dir, { accessKey: "yk_old", userId: "u0", userName: "ada" });
    await cmdUserCreate(target, dir, ["bea"]);
    expect(readCredentials(dir)?.accessKey).toBe("yk_old");
    expect(out.join("\n")).toContain("still authenticates as ada");
  });

  it("--save writes the credential", async () => {
    await cmdUserCreate(target, dir, ["bea", "--save"]);
    expect(readCredentials(dir)).toEqual({ accessKey: "yk_new", userId: "u1", userName: "bea" });
    expect(out.join("\n")).toContain("now authenticates as bea");
  });

  it("--save never overwrites an existing credential", async () => {
    writeCredentials(dir, { accessKey: "yk_old", userId: "u0", userName: "ada" });
    await cmdUserCreate(target, dir, ["bea", "--save"]);
    expect(readCredentials(dir)?.accessKey).toBe("yk_old");
    expect(out.join("\n")).toContain("Not saved");
    expect(out.join("\n")).toContain("still authenticates as ada");
  });

  it("rejects the removed --no-save flag", async () => {
    await expect(cmdUserCreate(target, dir, ["bea", "--no-save"])).rejects.toThrow();
  });
});
