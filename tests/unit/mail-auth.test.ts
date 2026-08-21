import { beforeEach, describe, expect, it } from "vitest";

import {
  clearTokenCache,
  readBody,
  resolveAuth,
  xoauth2Payload,
  type ResolvedAuth,
} from "../../src/core/drivers/mail/auth.js";
import { createCtx, createFakeEgress } from "../helpers/mail/egress.js";

const oauth2 = {
  client_id: "cid",
  client_secret: "s3cret-value",
  refresh_token: "refr3sh-value",
  token_url: "https://oauth2.example.test/token",
};

function tokenResponse(token: string, expires_in = 3600) {
  return { status: 200, text: async () => JSON.stringify({ access_token: token, expires_in, token_type: "Bearer" }) };
}

function tokenOf(auth: ResolvedAuth): string {
  if (auth?.kind !== "xoauth2") throw new Error("expected xoauth2 auth");
  return auth.token;
}

describe("xoauth2Payload", () => {
  it("encodes the SASL XOAUTH2 initial response", () => {
    const decoded = Buffer.from(xoauth2Payload("u@x.com", "tok"), "base64").toString("utf8");
    expect(decoded).toBe("user=u@x.com\x01auth=Bearer tok\x01\x01");
  });
});

describe("resolveAuth", () => {
  beforeEach(() => clearTokenCache());

  it("returns password auth when pass is set", async () => {
    const egress = createFakeEgress();
    const ctx = createCtx(egress);
    expect(await resolveAuth(ctx, { user: "u", pass: "p" })).toEqual({ kind: "password", user: "u", pass: "p" });
    expect(egress.fetchCalls).toHaveLength(0);
  });

  it("returns null when no credentials are configured", async () => {
    expect(await resolveAuth(createCtx(createFakeEgress()), { user: "u" })).toBeNull();
  });

  it("requires a user alongside the credential", async () => {
    const ctx = createCtx(createFakeEgress());
    await expect(resolveAuth(ctx, { user: "", pass: "p" })).rejects.toThrow(/user is required/);
    await expect(resolveAuth(ctx, { user: "", oauth2 })).rejects.toThrow(/user is required/);
  });

  it("refreshes an access token through egress.fetch", async () => {
    const egress = createFakeEgress();
    egress.fetchImpl = async () => tokenResponse("acc3ss-value");
    const ctx = createCtx(egress);
    const auth = await resolveAuth(ctx, { user: "u@x.com", oauth2 });
    expect(auth).toEqual({ kind: "xoauth2", user: "u@x.com", token: "acc3ss-value" });
    const call = egress.fetchCalls[0]!;
    expect(call.url).toBe(oauth2.token_url);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers?.["content-type"]).toMatch(/application\/x-www-form-urlencoded/);
    expect(call.init.redirect).toBe("manual");
    const form = new URLSearchParams(call.init.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "refresh_token",
      client_id: "cid",
      client_secret: "s3cret-value",
      refresh_token: "refr3sh-value",
    });
    expect(call.init.signal).toBe(ctx.signal);
    // Nothing secret reaches the log.
    const joined = ctx.logs.join("\n");
    expect(joined).toMatch(/token/i);
    for (const secret of ["s3cret-value", "refr3sh-value", "acc3ss-value"]) expect(joined).not.toContain(secret);
  });

  it("caches the token until 60 s before expiry, keyed by token_url/client_id/refresh_token", async () => {
    const egress = createFakeEgress();
    let n = 0;
    egress.fetchImpl = async () => tokenResponse(`tok${++n}`, 61);
    const ctx = createCtx(egress);
    expect(tokenOf(await resolveAuth(ctx, { user: "u", oauth2 }))).toBe("tok1");
    expect(tokenOf(await resolveAuth(ctx, { user: "u", oauth2 }))).toBe("tok1");
    expect(tokenOf(await resolveAuth(ctx, { user: "v", oauth2 }))).toBe("tok1");
    expect(tokenOf(await resolveAuth(ctx, { user: "u", oauth2: { ...oauth2, refresh_token: "other" } }))).toBe("tok2");
    expect(egress.fetchCalls).toHaveLength(2);
    // A token that expires in 61 s is useful for one second; after that it refreshes.
    await new Promise((r) => setTimeout(r, 1100));
    expect(tokenOf(await resolveAuth(ctx, { user: "u", oauth2 }))).toBe("tok3");
  });

  it("does not cache a short-lived token past its usable window", async () => {
    const egress = createFakeEgress();
    let n = 0;
    egress.fetchImpl = async () => tokenResponse(`tok${++n}`, 30);
    const ctx = createCtx(egress);
    expect(tokenOf(await resolveAuth(ctx, { user: "u", oauth2 }))).toBe("tok1");
    expect(tokenOf(await resolveAuth(ctx, { user: "u", oauth2 }))).toBe("tok2");
  });

  it("reports a failed refresh without leaking the secret, refresh token, or body", async () => {
    const egress = createFakeEgress();
    egress.fetchImpl = async () => ({
      status: 400,
      text: async () =>
        JSON.stringify({ error: "invalid_grant", error_description: "Token s3cret-value revoked refr3sh-value" }),
    });
    const ctx = createCtx(egress);
    let caught: unknown;
    try {
      await resolveAuth(ctx, { user: "u", oauth2 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/400/);
    expect(message).toMatch(/invalid_grant/);
    for (const secret of ["s3cret-value", "refr3sh-value"]) {
      expect(message).not.toContain(secret);
      expect(ctx.logs.join("\n")).not.toContain(secret);
    }
  });

  it("rejects a token response without an access_token", async () => {
    const egress = createFakeEgress();
    egress.fetchImpl = async () => ({ status: 200, text: async () => "not json" });
    await expect(resolveAuth(createCtx(egress), { user: "u", oauth2 })).rejects.toThrow(/access_token|JSON/);
  });

  it("reads a streamed token response and refuses one over 64 KiB without echoing it", async () => {
    const streamed = (text: string) => ({
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = Buffer.from(text, "utf8");
          for (let i = 0; i < bytes.length; i += 1024) controller.enqueue(new Uint8Array(bytes.subarray(i, i + 1024)));
          controller.close();
        },
      }),
    });
    const egress = createFakeEgress();
    egress.fetchImpl = async () => streamed(JSON.stringify({ access_token: "str3amed", expires_in: 3600 }));
    expect(tokenOf(await resolveAuth(createCtx(egress), { user: "u", oauth2 }))).toBe("str3amed");

    clearTokenCache();
    egress.fetchImpl = async () => streamed(JSON.stringify({ access_token: "hug3-token", padding: "x".repeat(70 * 1024) }));
    let caught: Error | undefined;
    await resolveAuth(createCtx(egress), { user: "u", oauth2 }).catch((e: Error) => (caught = e));
    expect(caught?.message).toMatch(/64 KiB|too large/);
    expect(caught?.message).not.toContain("hug3-token");
    expect(caught?.message).not.toContain("xxxx");

    clearTokenCache();
    egress.fetchImpl = async () => ({
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("x".repeat(65 * 1024)).buffer as ArrayBuffer,
    });
    await expect(resolveAuth(createCtx(egress), { user: "u", oauth2 })).rejects.toThrow(/64 KiB|too large/);
  });

  it("validates the oauth2 block", async () => {
    const ctx = createCtx(createFakeEgress());
    await expect(resolveAuth(ctx, { user: "u", oauth2: { ...oauth2, token_url: "http://x/token" } })).rejects.toThrow(
      /https/,
    );
    await expect(resolveAuth(ctx, { user: "u", oauth2: { ...oauth2, refresh_token: "" } })).rejects.toThrow(
      /refresh_token/,
    );
  });
});

describe("readBody", () => {
  it("prefers the stream, then arrayBuffer, then text, and caps each", async () => {
    const cap = 16;
    expect(await readBody({ status: 200, text: async () => "short" }, cap)).toBe("short");
    expect(await readBody({ status: 200, arrayBuffer: async () => new TextEncoder().encode("buf").buffer as ArrayBuffer }, cap)).toBe(
      "buf",
    );
    await expect(readBody({ status: 200, text: async () => "x".repeat(17) }, cap)).rejects.toThrow(/exceeded/);
    await expect(readBody({ status: 200 }, cap)).rejects.toThrow(/no body/);
  });
});
