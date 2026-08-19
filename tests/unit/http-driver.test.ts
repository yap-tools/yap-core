import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";

import { loadConfig, type YapConfig } from "../../src/config.js";
import { createEgress } from "../../src/core/drivers/egress.js";
import { createHttpDriver } from "../../src/core/drivers/http.js";
import type { Egress, RunContext } from "../../src/core/drivers/types.js";
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

interface RecordedFetch {
  url: string;
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
}

/** Builds a RunContext with a recording, injectable `egress.fetch`. */
function makeContext(
  config: unknown,
  params: Record<string, string>,
  fetchImpl: (url: string, init: RecordedFetch["init"]) => Promise<{ status: number; text(): Promise<string> }>,
): { ctx: RunContext; calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = [];
  const egress: Egress = {
    async fetch(url, init) {
      calls.push({ url, init: init as RecordedFetch["init"] });
      return fetchImpl(url, init as RecordedFetch["init"]);
    },
    async connect() {
      throw new Error("not used in these tests");
    },
    async assertPublic() {
      // no-op: pre-flight is exercised by the real-egress test below
    },
    async dispose() {},
  };
  const ctx: RunContext = {
    config,
    action: "fire",
    params,
    egress,
    writer: null,
    signal: new AbortController().signal,
    log: () => {},
  };
  return { ctx, calls };
}

describe("createHttpDriver: shape", () => {
  it("declares name, egress, and a single fire action", () => {
    const driver = createHttpDriver(testConfig());
    expect(driver.name).toBe("http");
    expect(driver.egress).toBe(true);
    expect(driver.writes).toBeUndefined();
    expect(Object.keys(driver.actions)).toEqual(["fire"]);
    expect(driver.actions.fire!.params).toBeNull();
    expect(driver.actions.fire!.timeoutMs).toBe(testConfig().hookTimeoutMs);
  });
});

describe("createHttpDriver: validateConfig", () => {
  const driver = createHttpDriver(testConfig());

  it("accepts a well-formed transport", () => {
    expect(() =>
      driver.validateConfig({ url: "https://api.example.com/x", method: "POST", body_template: "hi" }),
    ).not.toThrow();
  });

  it("rejects a bad method", () => {
    expect(() => driver.validateConfig({ url: "https://api.example.com/x", method: "TRACE" })).toThrow();
  });

  it("rejects both body_template and body_json", () => {
    expect(() =>
      driver.validateConfig({
        url: "https://api.example.com/x",
        method: "POST",
        body_template: "a",
        body_json: { a: 1 },
      }),
    ).toThrow(/body_template or body_json|not both/);
  });

  it("rejects a parameterized host", () => {
    expect(() => driver.validateConfig({ url: "http://{{host}}/x", method: "GET" })).toThrow(
      /host cannot contain parameters/,
    );
  });

  it("rejects an invalid URL", () => {
    expect(() => driver.validateConfig({ url: "not a url", method: "GET" })).toThrow();
  });
});

describe("createHttpDriver: validateConfigOnline", () => {
  it("asserts the materialized origin is public", async () => {
    const driver = createHttpDriver(testConfig());
    const seen: string[] = [];
    const egress: Egress = {
      async fetch() {
        throw new Error("not used");
      },
      async connect() {
        throw new Error("not used");
      },
      async assertPublic(url) {
        seen.push(url);
      },
      async dispose() {},
    };
    await driver.validateConfigOnline!(
      { url: "https://api.example.com/notify?to={{who}}", method: "GET" },
      egress,
    );
    expect(seen).toEqual(["https://api.example.com"]);
  });
});

describe("createHttpDriver: run", () => {
  const driver = createHttpDriver(testConfig());

  it("URL-encodes parameter values substituted into the URL", async () => {
    const { ctx, calls } = makeContext(
      { url: "https://api.example.com/notify?channel={{channel}}", method: "GET" },
      { channel: "a b&c=d" },
      async () => ({ status: 200, text: async () => "ok" }),
    );
    await driver.run(ctx);
    expect(calls[0]!.url).toBe("https://api.example.com/notify?channel=a%20b%26c%3Dd");
  });

  it("escapes values interpolated into a body_json string leaf, keeping them inside the string", async () => {
    const { ctx, calls } = makeContext(
      { url: "https://api.example.com/x", method: "POST", body_json: { text: "{{message}}" } },
      { message: '", "admin": true, "x": "' },
      async () => ({ status: 200, text: async () => "ok" }),
    );
    await driver.run(ctx);
    const body = calls[0]!.init.body!;
    const parsed = JSON.parse(body);
    expect(Object.keys(parsed)).toEqual(["text"]);
    expect(parsed.text).toBe('", "admin": true, "x": "');
    // content-type defaulted because none was declared
    expect(calls[0]!.init.headers?.["content-type"]).toBe("application/json");
  });

  it("preserves an explicit content-type when body_json is used", async () => {
    const { ctx, calls } = makeContext(
      {
        url: "https://api.example.com/x",
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body_json: { text: "{{message}}" },
      },
      { message: "x" },
      async () => ({ status: 200, text: async () => "ok" }),
    );
    await driver.run(ctx);
    expect(calls[0]!.init.headers?.["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("substitutes body_template raw, without escaping", async () => {
    const { ctx, calls } = makeContext(
      { url: "https://api.example.com/x", method: "POST", body_template: '{"text": "{{message}}"}' },
      { message: "deploy finished" },
      async () => ({ status: 200, text: async () => "ok" }),
    );
    await driver.run(ctx);
    expect(calls[0]!.init.body).toBe('{"text": "deploy finished"}');
  });

  it("sends no body on GET even when a body is configured", async () => {
    const { ctx, calls } = makeContext(
      { url: "https://api.example.com/x", method: "GET", body_template: "should not be sent" },
      {},
      async () => ({ status: 200, text: async () => "ok" }),
    );
    await driver.run(ctx);
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("rejects a CR/LF in a substituted header value before any request is sent", async () => {
    const { ctx, calls } = makeContext(
      { url: "https://api.example.com/x", method: "POST", headers: { "x-tag": "{{tag}}" } },
      { tag: "good\r\nx-injected: evil" },
      async () => ({ status: 200, text: async () => "ok" }),
    );
    await expect(driver.run(ctx)).rejects.toThrow(/line break|header/i);
    expect(calls).toHaveLength(0);
  });

  it("returns { status, body } on success", async () => {
    const { ctx } = makeContext(
      { url: "https://api.example.com/x", method: "GET" },
      {},
      async () => ({ status: 201, text: async () => "created" }),
    );
    await expect(driver.run(ctx)).resolves.toEqual({ status: 201, body: "created" });
  });

  it("collapses a pre-flight SSRF (assertPublic) failure to a generic forbidden error, never naming the host", async () => {
    const egress: Egress = {
      async fetch() {
        throw new YapError(
          "invalid_request",
          "service destination 192.168.0.1 resolves to a private, link-local, or localhost address",
        );
      },
      async connect() {
        throw new Error("not used");
      },
      async assertPublic() {},
      async dispose() {},
    };
    const ctx: RunContext = {
      config: { url: "http://192.168.0.1/internal", method: "GET" },
      action: "fire",
      params: {},
      egress,
      writer: null,
      signal: new AbortController().signal,
      log: () => {},
    };
    let caught: unknown;
    try {
      await driver.run(ctx);
      expect.unreachable("expected a forbidden YapError");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(YapError);
    expect((caught as YapError).code).toBe("forbidden");
    expect((caught as YapError).message).toMatch(/blocked by the SSRF guard/);
    expect((caught as YapError).message).not.toContain("192.168.0.1");
  });

  it("collapses an SSRF-pin-coded error (connect-time rebinding) to a generic forbidden error", async () => {
    const pinErr = Object.assign(new Error("SSRF guard blocked evil.example -> 10.0.0.1"), {
      code: SSRF_PIN_ERROR_CODE,
    });
    const { ctx } = makeContext({ url: "https://evil.example/x", method: "GET" }, {}, async () => {
      throw pinErr;
    });
    await expect(driver.run(ctx)).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringMatching(/blocked by the SSRF guard/),
    });
  });

  it("collapses an SSRF-pin-coded cause (fetch cause) to a generic forbidden error", async () => {
    const pinCauseErr = Object.assign(new Error("fetch failed"), {
      cause: { code: SSRF_PIN_ERROR_CODE },
    });
    const { ctx } = makeContext({ url: "https://evil.example/x", method: "GET" }, {}, async () => {
      throw pinCauseErr;
    });
    await expect(driver.run(ctx)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("maps other network errors to a generic internal error, not naming the destination", async () => {
    const { ctx } = makeContext(
      { url: "https://internal.corp/x", method: "GET" },
      {},
      async () => {
        throw new Error("ENOTFOUND internal.corp");
      },
    );
    let caught: unknown;
    try {
      await driver.run(ctx);
      expect.unreachable("expected an internal YapError");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(YapError);
    expect((caught as YapError).code).toBe("internal");
    expect((caught as YapError).message).not.toContain("internal.corp");
  });

  it("rethrows an abort as-is (the runs layer owns the timeout message)", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { ctx } = makeContext({ url: "https://api.example.com/x", method: "GET" }, {}, async () => {
      throw abortErr;
    });
    await expect(driver.run(ctx)).rejects.toBe(abortErr);
  });
});

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

describe("createHttpDriver: run (real egress)", () => {
  it("round-trips { status, body } through a real egress against a loopback server", async () => {
    await withHttpServer(
      (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ got: body }));
        });
      },
      async (port) => {
        const config = testConfig(["127.0.0.1"]);
        const driver = createHttpDriver(config);
        const egress = createEgress(config);
        try {
          const ctx: RunContext = {
            config: {
              url: `http://127.0.0.1:${port}/x`,
              method: "POST",
              body_json: { message: "{{message}}" },
            },
            action: "fire",
            params: { message: "hello" },
            egress,
            writer: null,
            signal: new AbortController().signal,
            log: () => {},
          };
          const result = await driver.run(ctx);
          expect(result).toEqual({ status: 201, body: JSON.stringify({ got: '{"message":"hello"}' }) });
        } finally {
          await egress.dispose();
        }
      },
    );
  });
});
