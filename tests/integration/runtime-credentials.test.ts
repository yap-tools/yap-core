/**
 * Runtime credentials: the load-bearing rotate-persist rule, the per-runtime
 * refresh lock, expiry-driven refresh, and stale handling. Driven with an
 * injected fake runtime so the contract is exercised without a provider.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";

import { decryptSecret } from "../../src/crypto.js";
import * as creds from "../../src/core/runtimeCredentials.js";
import type { CredentialBlob, Runtime } from "../../src/agent/runtimes/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { bootTestApp, type TestApp } from "../helpers/app.js";

const ONE_HOUR = 60 * 60 * 1000;

/** A fake runtime whose refresh() is a spy and whose blob carries rotations. */
function makeFakeRuntime(): { runtime: Runtime; refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn(async (blob: CredentialBlob) => {
    if (blob.failRefresh) throw new Error("revoked");
    const rotations = (Number(blob.rotations) || 0) + 1;
    const next: CredentialBlob = {
      rotations,
      accessToken: `access-${rotations}`,
      refreshToken: `refresh-${rotations}`,
      expiresAt: Date.now() + ONE_HOUR,
    };
    return { blob: next, accessToken: String(next.accessToken), expiresAt: next.expiresAt as number };
  });
  const runtime: Runtime = {
    descriptor: { name: "fake", image: "img", yapKeyEnv: "K", modelTokenEnv: "T", command: ["run"] },
    authorize: async () => ({ rotations: 0, accessToken: "access-0", refreshToken: "refresh-0" }),
    capture: async () => ({ rotations: 0, accessToken: "access-0", refreshToken: "refresh-0" }),
    refresh,
    materialize: (blob) => ({
      accessToken: String(blob.accessToken ?? ""),
      expiresAt: typeof blob.expiresAt === "number" ? blob.expiresAt : undefined,
    }),
  };
  return { runtime, refresh };
}

describeEachAdapter("runtime credentials", (adapter) => {
  let app: TestApp;
  let env: creds.RuntimeCredEnv;
  let refresh: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
  });
  afterAll(async () => {
    await app.stop();
  });

  beforeEach(async () => {
    const fake = makeFakeRuntime();
    refresh = fake.refresh;
    env = { db: app.db, config: app.config, getRuntime: (n) => (n === "fake" ? fake.runtime : null) };
    await creds.revokeCredential(env, "fake").catch(() => {});
  });

  it("stores a credential as active and encrypted at rest", async () => {
    await creds.storeCredential(env, "fake", { rotations: 0, accessToken: "access-0", expiresAt: Date.now() + ONE_HOUR });
    const status = await creds.getCredentialStatus(env, "fake");
    expect(status?.status).toBe("active");
    const { runtimeCredentials } = app.db.tables;
    const row = (await app.db.client.select().from(runtimeCredentials).where(eq(runtimeCredentials.runtime, "fake")))[0]!;
    expect(row.blobEncrypted).toMatch(/^v1\./);
    expect(row.blobEncrypted).not.toContain("access-0");
  });

  it("does not refresh a token that is still valid", async () => {
    await creds.storeCredential(env, "fake", { rotations: 5, accessToken: "access-5", expiresAt: Date.now() + ONE_HOUR });
    const { accessToken } = await creds.resolveAccessToken(env, "fake");
    expect(accessToken).toBe("access-5");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and PERSISTS the rotated blob", async () => {
    await creds.storeCredential(env, "fake", { rotations: 0, accessToken: "access-0", expiresAt: Date.now() - 1000 });
    const { accessToken } = await creds.resolveAccessToken(env, "fake");
    expect(accessToken).toBe("access-1");
    expect(refresh).toHaveBeenCalledTimes(1);
    // The rotated blob must be what's now stored — the single most important rule.
    const { runtimeCredentials } = app.db.tables;
    const row = (await app.db.client.select().from(runtimeCredentials).where(eq(runtimeCredentials.runtime, "fake")))[0]!;
    const stored = JSON.parse(decryptSecret(row.blobEncrypted, app.config.masterKey));
    expect(stored.rotations).toBe(1);
    expect(stored.refreshToken).toBe("refresh-1");
  });

  it("serializes concurrent refreshes to exactly one", async () => {
    await creds.storeCredential(env, "fake", { rotations: 0, accessToken: "access-0" }); // no expiry hint
    const [a, b] = await Promise.all([creds.resolveAccessToken(env, "fake"), creds.resolveAccessToken(env, "fake")]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe("access-1");
    expect(b.accessToken).toBe("access-1");
  });

  it("marks the credential stale when refresh fails", async () => {
    await creds.storeCredential(env, "fake", { failRefresh: true, accessToken: "access-0", expiresAt: Date.now() - 1 });
    await expect(creds.resolveAccessToken(env, "fake")).rejects.toThrow(/stale/);
    expect((await creds.getCredentialStatus(env, "fake"))?.status).toBe("stale");
  });

  it("refreshNow returns stale instead of throwing", async () => {
    await creds.storeCredential(env, "fake", { failRefresh: true, accessToken: "access-0" });
    expect(await creds.refreshNow(env, "fake")).toEqual({ status: "stale" });
    await creds.storeCredential(env, "fake", { rotations: 0, accessToken: "access-0" });
    expect(await creds.refreshNow(env, "fake")).toEqual({ status: "active" });
  });
});
