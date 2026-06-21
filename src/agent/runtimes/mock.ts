/**
 * The mock runtime: a deterministic, network-free reference implementation of
 * the runtime contract. It ships as a built-in so the agent pipeline is
 * exercisable end-to-end (and unit-testable) without a real model provider.
 *
 * Its credential blob is a tiny rotating token:
 *   { rotations, accessToken, refreshToken, expiresAt?, failRefresh? }
 * Each refresh increments `rotations` and mints a fresh token, so tests can
 * assert the rotated blob is persisted. Set `failRefresh: true` in a stored
 * blob to simulate a revoked login (refresh throws → credential goes stale).
 */
import type { CredentialBlob, RefreshResult, Runtime } from "./index.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

function tokenForRotation(rotations: number, now: number): CredentialBlob {
  return {
    rotations,
    accessToken: `mock-access-${rotations}`,
    refreshToken: `mock-refresh-${rotations}`,
    expiresAt: now + ONE_HOUR_MS,
  };
}

export const mockRuntime: Runtime = {
  descriptor: {
    name: "mock",
    image: "yap/mock-runtime:latest",
    models: ["mock-1", "mock-2"],
    yapKeyEnv: "YAP_ACCESS_KEY",
    modelTokenEnv: "MODEL_TOKEN",
    command: ["/bin/run-agent"],
  },
  authorize: async ({ log }) => {
    log("mock runtime: issuing a deterministic credential (no real provider login)");
    return tokenForRotation(0, Date.now());
  },
  capture: async () => tokenForRotation(0, Date.now()),
  refresh: async (blob: CredentialBlob): Promise<RefreshResult> => {
    if (blob.failRefresh) {
      throw new Error("mock runtime: refresh rejected (simulated revoked login)");
    }
    const rotations = (Number(blob.rotations) || 0) + 1;
    const next = tokenForRotation(rotations, Date.now());
    return { blob: next, accessToken: String(next.accessToken), expiresAt: next.expiresAt as number };
  },
  materialize: (blob: CredentialBlob) => ({
    accessToken: String(blob.accessToken ?? ""),
    expiresAt: typeof blob.expiresAt === "number" ? blob.expiresAt : undefined,
  }),
};
