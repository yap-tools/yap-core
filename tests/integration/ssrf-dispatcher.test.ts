/**
 * Proves the pinned-DNS dispatcher actually governs the connection: undici
 * resolves the host through our validating lookup and connects only to the
 * address that lookup returns — so there is no second, unvalidated resolution
 * for a rebinding attacker to exploit. A fixed fake DNS makes it deterministic
 * (host "rebind.test" → 127.0.0.1, where the test server listens).
 */
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, fetch as undiciFetch } from "undici";

import { createPinningLookup, type AllAddressLookup } from "../../src/core/ssrf.js";
import { getFreePort } from "../helpers/app.js";

describe("pinned-DNS dispatcher", () => {
  let server: Server;
  let port: number;

  // Always resolves to the loopback address the server actually listens on.
  const fakeDns: AllAddressLookup = (_hostname, _options, callback) =>
    callback(null, [{ address: "127.0.0.1", family: 4 }]);

  beforeAll(async () => {
    port = await getFreePort();
    server = createServer((_req, res) => res.writeHead(200).end("reached"));
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it("blocks the connection when the host resolves to a private address", async () => {
    const agent = new Agent({ connect: { lookup: createPinningLookup([], fakeDns) } });
    try {
      // rebind.test → 127.0.0.1 (private, not allowlisted) → connect rejected.
      await expect(undiciFetch(`http://rebind.test:${port}/`, { dispatcher: agent })).rejects.toThrow();
    } finally {
      await agent.destroy();
    }
  });

  it("connects through to the validated address when it is allowlisted", async () => {
    const agent = new Agent({ connect: { lookup: createPinningLookup(["127.0.0.1"], fakeDns) } });
    try {
      const res = await undiciFetch(`http://rebind.test:${port}/`, { dispatcher: agent });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("reached");
    } finally {
      await agent.destroy();
    }
  });
});
