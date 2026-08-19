import { randomBytes } from "node:crypto";
import net from "node:net";
import { describe, expect, it } from "vitest";

import { loadConfig, type YapConfig } from "../../src/config.js";
import { DriverRegistry, validateDriverDefinition } from "../../src/core/drivers/registry.js";
import { createEgress } from "../../src/core/drivers/egress.js";
import { DRIVER_API, type DriverDefinition } from "../../src/core/drivers/types.js";
import { YapError } from "../../src/core/errors.js";
import { SSRF_PIN_ERROR_CODE } from "../../src/core/ssrf.js";

const baseEnv = {
  YAP_SYSADMIN_KEY: "sysadmin-key-0123456789",
  YAP_MASTER_KEY: randomBytes(32).toString("base64"),
};

function testConfig(allowHosts?: string[]): YapConfig {
  return loadConfig({
    ...baseEnv,
    ...(allowHosts ? { YAP_HOOK_ALLOW_HOSTS: allowHosts.join(",") } : {}),
  });
}

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "demo",
    api: DRIVER_API,
    description: "A demo driver.",
    egress: false,
    validateConfig() {},
    actions: {
      ping: { description: "Ping.", params: [{ name: "who", required: true }], timeoutMs: 5000 },
    },
    async run() {
      return { ok: true };
    },
    ...overrides,
  };
}

describe("validateDriverDefinition", () => {
  it("accepts a well-formed definition and returns it", () => {
    const def = definition();
    expect(validateDriverDefinition(def)).toBe(def);
  });

  it("rejects a definition that is not an object", () => {
    expect(() => validateDriverDefinition(null)).toThrow(YapError);
    expect(() => validateDriverDefinition("driver")).toThrow(/driver definition/);
  });

  it("rejects a wrong api version, naming the field", () => {
    expect(() => validateDriverDefinition(definition({ api: 2 }))).toThrow(/api/);
    expect(() => validateDriverDefinition(definition({ api: undefined }))).toThrow(/api/);
  });

  it("rejects a bad name, naming the field", () => {
    for (const name of ["Demo", "1demo", "demo_driver", "d", "demo!", "", 42, undefined]) {
      expect(() => validateDriverDefinition(definition({ name })), String(name)).toThrow(/name/);
    }
    expect(validateDriverDefinition(definition({ name: "http-json" }))).toBeTruthy();
  });

  it("rejects a missing description or egress flag", () => {
    expect(() => validateDriverDefinition(definition({ description: "" }))).toThrow(/description/);
    expect(() => validateDriverDefinition(definition({ egress: "yes" }))).toThrow(/egress/);
  });

  it("rejects a missing run function", () => {
    expect(() => validateDriverDefinition(definition({ run: undefined }))).toThrow(/run/);
    expect(() => validateDriverDefinition(definition({ run: "nope" }))).toThrow(/run/);
  });

  it("rejects a missing validateConfig function", () => {
    expect(() => validateDriverDefinition(definition({ validateConfig: undefined }))).toThrow(
      /validateConfig/,
    );
  });

  it("rejects actions that are not an object", () => {
    expect(() => validateDriverDefinition(definition({ actions: undefined }))).toThrow(/actions/);
    expect(() => validateDriverDefinition(definition({ actions: [] }))).toThrow(/actions/);
  });

  it("rejects an action with a non-positive or fractional timeoutMs, naming the action", () => {
    for (const timeoutMs of [-1, 0, 1.5, "5000", undefined]) {
      expect(
        () =>
          validateDriverDefinition(
            definition({ actions: { ping: { description: "Ping.", params: null, timeoutMs } } }),
          ),
        String(timeoutMs),
      ).toThrow(/actions\.ping\.timeoutMs/);
    }
  });

  it("accepts null params (specs come from the service record)", () => {
    expect(
      validateDriverDefinition(
        definition({ actions: { ping: { description: "Ping.", params: null, timeoutMs: 1 } } }),
      ),
    ).toBeTruthy();
  });

  it("rejects malformed or duplicate action params, naming the action", () => {
    const withParams = (params: unknown) =>
      definition({ actions: { ping: { description: "Ping.", params, timeoutMs: 1000 } } });
    expect(() => validateDriverDefinition(withParams("who"))).toThrow(/actions\.ping\.params/);
    expect(() => validateDriverDefinition(withParams([{ name: "not a name" }]))).toThrow(
      /actions\.ping\.params/,
    );
    expect(() => validateDriverDefinition(withParams([{ name: "who" }, { name: "who" }]))).toThrow(
      /duplicate/,
    );
  });

  it("rejects a malformed writes declaration", () => {
    expect(() => validateDriverDefinition(definition({ writes: { items: "yes" } }))).toThrow(
      /writes\.items/,
    );
    expect(validateDriverDefinition(definition({ writes: { items: true } }))).toBeTruthy();
  });
});

describe("DriverRegistry", () => {
  const def = () => definition() as unknown as DriverDefinition;

  it("registers, gets, has, and lists", () => {
    const registry = new DriverRegistry();
    expect(registry.has("demo")).toBe(false);
    const demo = def();
    registry.register(demo);
    expect(registry.has("demo")).toBe(true);
    expect(registry.get("demo")).toBe(demo);
    expect(registry.list()).toEqual([demo]);
  });

  it("rejects duplicate registrations", () => {
    const registry = new DriverRegistry();
    registry.register(def());
    expect(() => registry.register(def())).toThrow(/already registered/);
  });

  it("validates on register", () => {
    const registry = new DriverRegistry();
    expect(() => registry.register(definition({ api: 99 }) as unknown as DriverDefinition)).toThrow(
      YapError,
    );
    expect(registry.has("demo")).toBe(false);
  });

  it("get throws not_found for an unknown driver", () => {
    const registry = new DriverRegistry();
    try {
      registry.get("nope");
      expect.unreachable("expected a not_found error");
    } catch (err) {
      expect(err).toBeInstanceOf(YapError);
      expect((err as YapError).code).toBe("not_found");
      expect((err as YapError).message).toContain("nope");
    }
  });
});

describe("createEgress: assertPublic", () => {
  it("denies a private destination without an allowlist", async () => {
    const egress = createEgress(testConfig());
    await expect(egress.assertPublic("http://127.0.0.1/x")).rejects.toThrow(YapError);
  });

  it("permits an allowlisted private destination", async () => {
    const egress = createEgress(testConfig(["127.0.0.1"]));
    await expect(egress.assertPublic("http://127.0.0.1/x")).resolves.toBeUndefined();
  });

  it("uses the injected resolver", async () => {
    const egress = createEgress(testConfig(), async () => ["10.1.2.3"]);
    await expect(egress.assertPublic("https://internal.corp/x")).rejects.toThrow(/private/);
  });
});

describe("createEgress: fetch", () => {
  it("pre-flights the SSRF guard before the request", async () => {
    let called = false;
    const egress = createEgress(testConfig(), async () => ["10.1.2.3"], async () => {
      called = true;
      return new Response("nope");
    });
    await expect(egress.fetch("https://internal.corp/x", { method: "GET" })).rejects.toThrow(YapError);
    expect(called).toBe(false);
  });

  it("passes the request through once the destination is public", async () => {
    const seen: Array<[string, unknown]> = [];
    const egress = createEgress(testConfig(), async () => ["93.184.216.34"], async (url, init) => {
      seen.push([String(url), init]);
      return new Response("hi", { status: 201 });
    });
    const res = await egress.fetch("https://api.example.com/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("hi");
    expect(seen[0]?.[0]).toBe("https://api.example.com/x");
    expect((seen[0]?.[1] as { redirect?: string }).redirect).toBe("manual");
  });
});

describe("createEgress: connect", () => {
  it("rejects a blocked address with the SSRF pin error code", async () => {
    const egress = createEgress(testConfig());
    await expect(egress.connect("127.0.0.1", 9)).rejects.toMatchObject({
      code: SSRF_PIN_ERROR_CODE,
    });
  });

  it("rejects a hostname that resolves into a blocked range", async () => {
    const egress = createEgress(testConfig(), async () => ["169.254.169.254"]);
    await expect(egress.connect("metadata.internal", 80)).rejects.toMatchObject({
      code: SSRF_PIN_ERROR_CODE,
    });
  });

  it("connects to an allowlisted host and returns a live duplex", async () => {
    const server = net.createServer((socket) => socket.end("pong"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const egress = createEgress(testConfig(["127.0.0.1"]));
      const socket = await egress.connect("127.0.0.1", port);
      const body = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        socket.on("data", (c: Buffer) => chunks.push(c));
        socket.on("end", () => resolve(Buffer.concat(chunks).toString()));
        socket.on("error", reject);
      });
      expect(body).toBe("pong");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
