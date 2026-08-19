import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";

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

/** Runs `fn` against a throwaway loopback HTTP server, always closing it. */
async function withHttpServer(
  handler: http.RequestListener,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  try {
    await fn(port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Captures the sockets `createEgress().connect` opens so a test can assert
 * they were destroyed — egress only hands back a socket on success. */
function captureSockets(): { sockets: net.Socket[]; restore: () => void } {
  const sockets: net.Socket[] = [];
  const actual = net.connect;
  const spy = vi
    .spyOn(net, "connect")
    .mockImplementation(((...args: Parameters<typeof net.connect>) => {
      const socket = (actual as (...a: unknown[]) => net.Socket)(...args);
      sockets.push(socket);
      return socket;
    }) as typeof net.connect);
  return { sockets, restore: () => spy.mockRestore() };
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

// The tests above inject fetchImpl, which skips the undici dispatcher entirely.
// These exercise the real path: pinning Agent + createPinningLookup + manual
// redirects, against a loopback server that only an allowlist can reach.
describe("createEgress: fetch (real transport)", () => {
  it("performs a real request through the pinning dispatcher", async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("real-pong");
      },
      async (port) => {
        const egress = createEgress(testConfig(["127.0.0.1"]));
        try {
          const res = await egress.fetch(`http://127.0.0.1:${port}/x`, { method: "GET" });
          expect(res.status).toBe(200);
          expect(await res.text()).toBe("real-pong");
        } finally {
          await egress.dispose();
        }
      },
    );
  });

  it("returns a 302 instead of following it", async () => {
    let redirectTarget = "";
    let privateHits = 0;
    await withHttpServer(
      (req, res) => {
        if (req.url === "/private") {
          privateHits += 1;
          res.writeHead(200);
          res.end("secret");
          return;
        }
        res.writeHead(302, { location: redirectTarget });
        res.end();
      },
      async (port) => {
        redirectTarget = `http://127.0.0.1:${port}/private`;
        const egress = createEgress(testConfig(["127.0.0.1"]));
        try {
          const res = await egress.fetch(`http://127.0.0.1:${port}/start`, { method: "GET" });
          expect(res.status).toBe(302);
          await res.text();
          expect(privateHits).toBe(0);
        } finally {
          await egress.dispose();
        }
      },
    );
  });

  it("rejects a private destination before any connection is made", async () => {
    let hits = 0;
    await withHttpServer(
      (_req, res) => {
        hits += 1;
        res.writeHead(200);
        res.end("reached");
      },
      async (port) => {
        const egress = createEgress(testConfig()); // no allowlist
        try {
          await expect(egress.fetch(`http://127.0.0.1:${port}/x`, { method: "GET" })).rejects.toThrow(
            YapError,
          );
          expect(hits).toBe(0);
        } finally {
          await egress.dispose();
        }
      },
    );
  });
});

describe("createEgress: dispose", () => {
  it("is a no-op when nothing ever fetched, and is idempotent", async () => {
    const egress = createEgress(testConfig());
    await expect(egress.dispose()).resolves.toBeUndefined();
    await expect(egress.dispose()).resolves.toBeUndefined();
  });

  it("releases the pool and refuses further use", async () => {
    await withHttpServer(
      (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
      async (port) => {
        const egress = createEgress(testConfig(["127.0.0.1"]));
        const res = await egress.fetch(`http://127.0.0.1:${port}/x`, { method: "GET" });
        await res.text();
        await egress.dispose();
        await egress.dispose(); // idempotent after a pool was actually opened
        await expect(egress.fetch(`http://127.0.0.1:${port}/x`, { method: "GET" })).rejects.toThrow(
          /disposed/,
        );
      },
    );
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

  it("rejects a port that is not an integer in 1-65535, naming the field", async () => {
    const egress = createEgress(testConfig(["127.0.0.1"]));
    for (const port of [0, -1, 1.5, 65536, Number.NaN]) {
      await expect(egress.connect("127.0.0.1", port), String(port)).rejects.toThrow(/port/);
    }
  });

  // 203.0.113.0/24 is TEST-NET-3: not in ssrf.ts's PRIVATE_V4_RANGES, so it
  // passes the guard, and it is unroutable, so the connect never completes.
  it("rejects with an AbortError and destroys the socket when the signal fires", async () => {
    const { sockets, restore } = captureSockets();
    try {
      const egress = createEgress(testConfig());
      const controller = new AbortController();
      const pending = egress.connect("203.0.113.1", 80, { signal: controller.signal, timeoutMs: 5000 });
      setTimeout(() => controller.abort(), 50);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.destroyed).toBe(true);
    } finally {
      restore();
    }
  });

  it("times out a connect that never completes and destroys the socket", async () => {
    const { sockets, restore } = captureSockets();
    try {
      const egress = createEgress(testConfig());
      await expect(egress.connect("203.0.113.1", 80, { timeoutMs: 200 })).rejects.toThrow(
        /timed out after 200ms/,
      );
      expect(sockets).toHaveLength(1);
      expect(sockets[0]!.destroyed).toBe(true);
    } finally {
      restore();
    }
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const egress = createEgress(testConfig(["127.0.0.1"]));
    await expect(
      egress.connect("127.0.0.1", 9, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
