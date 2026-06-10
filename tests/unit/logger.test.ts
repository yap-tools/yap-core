import { describe, expect, it } from "vitest";

import { createLogger, redact } from "../../src/logger.js";

describe("redact", () => {
  it("redacts access keys anywhere in a string", () => {
    const key = "yap_3q2-abcDEF0123456789_xyz";
    expect(redact(`auth failed for ${key} on /v1/spaces`)).not.toContain(key);
    expect(redact(`auth failed for ${key}`)).toContain("yap_[REDACTED]");
  });

  it("redacts query-param fallback keys", () => {
    const line = "GET /mcp?key=supersecretvalue&x=1";
    expect(redact(line)).toBe("GET /mcp?key=[REDACTED]&x=1");
  });

  it("leaves ordinary text alone", () => {
    expect(redact("hello world /v1/spaces")).toBe("hello world /v1/spaces");
  });
});

describe("createLogger", () => {
  it("redacts inside strings, errors, and nested objects", () => {
    const lines: unknown[][] = [];
    const sink = {
      debug: (...a: unknown[]) => lines.push(a),
      info: (...a: unknown[]) => lines.push(a),
      log: (...a: unknown[]) => lines.push(a),
      warn: (...a: unknown[]) => lines.push(a),
      error: (...a: unknown[]) => lines.push(a),
    };
    const logger = createLogger(sink);
    const key = "yap_SECRETSECRETSECRET123";
    logger.info(`bearer ${key}`, { nested: { url: `/mcp?key=${key}` } });
    logger.error(new Error(`boom ${key}`));
    const flat = JSON.stringify(lines);
    expect(flat).not.toContain(key);
    expect(flat).toContain("yap_[REDACTED]");
  });
});
