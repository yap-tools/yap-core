/**
 * Sideloading: the server fetches a caller-supplied URL and stores it as a
 * finalized file in one call.
 *
 * Two halves. The core half drives `sideloadFile` with an injected resolver
 * and fetch (as runs.test.ts does for the http driver), which is what makes
 * the redirect, size, MIME, naming and time-cap rules deterministic. The
 * transport half boots a real upstream on loopback (allowlisted) and goes
 * through REST and MCP, so the real undici path — manual redirects, response
 * headers, a streamed body — is exercised too, along with the kill switch.
 */
import { readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MAX_SIDELOAD_REDIRECTS, openDownloadStream, sideloadFile, type FileEnv } from "../../src/core/files.js";
import { YapError } from "../../src/core/errors.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, getFreePort, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

const MAX_BYTES = 1024;

type Responder = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Every regular file under the blob root — a leftover blob shows up here. */
function blobCount(app: TestApp): number {
  if (app.config.blob.driver !== "fs") throw new Error("these tests assume the fs blob store");
  return readdirSync(app.config.blob.root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
}

async function fileRowCount(app: TestApp): Promise<number> {
  // Counts every status: a leftover `reserved` placeholder would be a bug too.
  return (await app.db.client.select().from(app.db.tables.files)).length;
}

async function storedText(env: FileEnv, fileId: string): Promise<string> {
  const { stream } = await openDownloadStream(env, fileId);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** A body that hands out `chunks` and reports whether anyone read it. */
function trackedBody(chunks: string[], opts: { stallAfter?: boolean } = {}) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[state.pulled];
      state.pulled++;
      if (chunk !== undefined) return controller.enqueue(new TextEncoder().encode(chunk));
      if (opts.stallAfter) return new Promise<void>(() => {}); // never ends, ignores everything
      controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, state };
}

describeEachAdapter("sideload (core)", (adapter) => {
  let app: TestApp;
  let aliceId: string;
  let bobId: string;
  let bundleId: string;
  let alice: ApiClient;
  let requests: Array<{ url: string; init: RequestInit }>;
  let resolved: string[];

  /** A FileEnv whose network is the given responder; `internal.test` resolves privately. */
  const envWith = (respond: Responder, config: Partial<TestApp["config"]> = {}): FileEnv => ({
    db: app.db,
    blob: app.blob,
    config: { ...app.config, ...config },
    resolver: async (hostname) => {
      resolved.push(hostname);
      return hostname === "internal.test" ? ["10.0.0.5"] : ["93.184.216.34"];
    },
    fetchImpl: (async (input: string, init: RequestInit) => {
      requests.push({ url: input, init });
      return respond(new URL(input), init);
    }) as unknown as typeof fetch,
  });

  const failure = async (work: Promise<unknown>): Promise<YapError> => {
    const err = await work.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err, "expected the sideload to be refused").toBeInstanceOf(YapError);
    return err as YapError;
  };

  const expectNothingLeftBehind = async () => {
    expect(await fileRowCount(app)).toBe(0);
    expect(blobCount(app)).toBe(0);
  };

  beforeAll(async () => {
    app = await bootTestApp({ YAP_MAX_FILE_SIZE_BYTES: String(MAX_BYTES) }, await adapter.makeDb());
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    aliceId = a.body.user.id;
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    bobId = (await sysadmin.post("/v1/users", { name: "Bob" })).body.user.id;
    const spaceId = (await alice.post("/v1/spaces", { name: "Sideload" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "assets" })).body.id;
  });

  beforeEach(async () => {
    requests = [];
    resolved = [];
    for (const file of (await alice.get(`/v1/bundles/${bundleId}/files`)).body.data) {
      await alice.delete(`/v1/files/${file.id}`);
    }
  });

  afterAll(async () => {
    await app.stop();
  });

  it("stores the file and returns it finalized, sending a bare GET", async () => {
    const env = envWith(() => new Response("hello", { headers: { "content-type": "text/plain; charset=utf-8" } }));
    const file = await sideloadFile(env, aliceId, bundleId, {
      url: "https://files.example/docs/report%20final.txt?sig=secret",
    });

    expect(file).toEqual({
      id: expect.any(String),
      name: "report final.txt",
      mimeType: "text/plain",
      size: 5,
      status: "finalized",
      createdAt: expect.any(String),
    });
    expect(await storedText(env, file.id)).toBe("hello");
    expect(blobCount(app)).toBe(1);
    const listed = (await alice.get(`/v1/bundles/${bundleId}/files`)).body.data;
    expect(listed.map((f: { id: string }) => f.id)).toEqual([file.id]);

    expect(requests).toHaveLength(1);
    const { init } = requests[0]!;
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("does not keep the source URL anywhere on the file record", async () => {
    const env = envWith(() => new Response("x"));
    const file = await sideloadFile(env, aliceId, bundleId, { url: "https://files.example/a.txt?token=s3cr3t" });
    const [row] = await app.db.client.select().from(app.db.tables.files);
    expect(row!.id).toBe(file.id);
    expect(JSON.stringify(row)).not.toContain("files.example");
    expect(JSON.stringify(row)).not.toContain("s3cr3t");
  });

  it("derives the name from Content-Disposition, then the final URL, then falls back", async () => {
    const named = async (url: string, disposition?: string) =>
      (
        await sideloadFile(
          envWith(() => new Response("x", disposition ? { headers: { "content-disposition": disposition } } : {})),
          aliceId,
          bundleId,
          { url },
        )
      ).name;

    expect(await named("https://files.example/dl?id=1", 'attachment; filename="q3 report.pdf"')).toBe("q3 report.pdf");
    expect(await named("https://files.example/dl", "attachment; filename=plain.csv; size=3")).toBe("plain.csv");
    expect(await named("https://files.example/dl", "attachment; filename=\"fallback.txt\"; filename*=UTF-8''na%C3%AFve.txt")).toBe(
      "naïve.txt",
    );
    // No header: the last path segment, percent-decoded.
    expect(await named("https://files.example/a/b/caf%C3%A9.png?x=1")).toBe("café.png");
    // Nothing usable anywhere.
    expect(await named("https://files.example/")).toBe("download");
    expect(await named("https://files.example/dir/")).toBe("download");
  });

  it("sanitises a derived name instead of failing the call", async () => {
    const env = envWith(
      () => new Response("x", { headers: { "content-disposition": 'attachment; filename="..\\..\\etc/pass\twd"' } }),
    );
    expect((await sideloadFile(env, aliceId, bundleId, { url: "https://files.example/x" })).name).toBe("passwd");

    // An encoded separator in the URL's last segment cannot smuggle a path either.
    const fromUrl = await sideloadFile(envWith(() => new Response("x")), aliceId, bundleId, {
      url: "https://files.example/files/a%2Fb.txt",
    });
    expect(fromUrl.name).toBe("b.txt");

    const long = await sideloadFile(envWith(() => new Response("x")), aliceId, bundleId, {
      url: `https://files.example/${"n".repeat(400)}.bin`,
    });
    expect(long.name).toHaveLength(255);
  });

  it("lets the caller's name and mime_type win, and validates the name strictly", async () => {
    const respond: Responder = () =>
      new Response("<html>", {
        headers: { "content-type": "text/html", "content-disposition": 'attachment; filename="theirs.html"' },
      });
    const file = await sideloadFile(envWith(respond), aliceId, bundleId, {
      url: "https://files.example/page",
      name: "mine.bin",
      mime_type: "application/octet-stream",
    });
    expect(file.name).toBe("mine.bin");
    expect(file.mimeType).toBe("application/octet-stream");

    requests = [];
    const err = await failure(
      sideloadFile(envWith(respond), aliceId, bundleId, { url: "https://files.example/page", name: "a/b.txt" }),
    );
    expect(err.code).toBe("invalid_request");
    expect(requests).toHaveLength(0);
  });

  it("stores no MIME type when the response declares none", async () => {
    const env = envWith(() => new Response(new TextEncoder().encode("raw")));
    const file = await sideloadFile(env, aliceId, bundleId, { url: "https://files.example/blob" });
    expect(file.mimeType).toBe("");
    expect(file.size).toBe(3);
  });

  it("follows a redirect and names the file after where it ended up", async () => {
    const env = envWith((url) =>
      url.pathname === "/short"
        ? new Response(null, { status: 302, headers: { location: "https://cdn.example/real/photo.jpg" } })
        : new Response("jpeg-bytes", { headers: { "content-type": "image/jpeg" } }),
    );
    const file = await sideloadFile(env, aliceId, bundleId, { url: "https://files.example/short" });
    expect(file.name).toBe("photo.jpg");
    expect(file.mimeType).toBe("image/jpeg");
    expect(requests.map((r) => r.url)).toEqual(["https://files.example/short", "https://cdn.example/real/photo.jpg"]);
    // Each hop went back through the guard's resolution.
    expect(resolved).toEqual(["files.example", "cdn.example"]);
  });

  it("resolves a relative redirect against the URL it came from", async () => {
    const env = envWith((url) =>
      url.pathname === "/a/start"
        ? new Response(null, { status: 307, headers: { location: "../b/end.txt" } })
        : new Response("ok"),
    );
    const file = await sideloadFile(env, aliceId, bundleId, { url: "https://files.example/a/start" });
    expect(file.name).toBe("end.txt");
    expect(requests[1]!.url).toBe("https://files.example/b/end.txt");
  });

  it("blocks a redirect to a private address without naming it", async () => {
    for (const location of ["http://internal.test/secret", "http://169.254.169.254/latest/meta-data"]) {
      requests = [];
      const env = envWith(() => new Response(null, { status: 302, headers: { location } }));
      const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/bounce" }));
      expect(err.code).toBe("forbidden");
      expect(err.message).not.toMatch(/internal\.test|10\.0\.0\.5|169\.254/);
      // The private hop was never requested.
      expect(requests.map((r) => r.url)).toEqual(["https://files.example/bounce"]);
    }
    await expectNothingLeftBehind();
  });

  it("refuses a private or unresolvable destination with one generic message", async () => {
    const messages = new Set<string>();
    for (const url of ["http://internal.test/x", "http://127.0.0.1:8787/v1/health", "http://[::1]/x"]) {
      const err = await failure(sideloadFile(envWith(() => new Response("never")), aliceId, bundleId, { url }));
      expect(err.code).toBe("forbidden");
      expect(err.message).not.toMatch(/10\.0\.0\.5|127\.0\.0\.1|::1|internal\.test/);
      messages.add(err.message);
    }
    const unresolvable: FileEnv = {
      ...envWith(() => new Response("never")),
      resolver: async () => {
        throw new Error("ENOTFOUND");
      },
    };
    const err = await failure(sideloadFile(unresolvable, aliceId, bundleId, { url: "https://nowhere.example/x" }));
    messages.add(err.message);
    // Blocked and unresolvable are indistinguishable to the caller.
    expect(messages.size).toBe(1);
    expect(requests).toHaveLength(0);
  });

  it("collapses a transport failure into a generic error", async () => {
    const env = envWith(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED 93.184.216.34:443") });
    });
    const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/x" }));
    expect(err.code).toBe("bad_gateway");
    expect(err.message).not.toMatch(/ECONNREFUSED|93\.184/);
    await expectNothingLeftBehind();
  });

  it("gives up after too many redirects", async () => {
    let n = 0;
    const env = envWith(() => new Response(null, { status: 302, headers: { location: `/hop/${++n}` } }));
    const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/hop/0" }));
    expect(err.code).toBe("bad_gateway");
    expect(err.message).toContain(`more than ${MAX_SIDELOAD_REDIRECTS} times`);
    // The original request plus five followed hops; the sixth redirect is the error.
    expect(requests).toHaveLength(MAX_SIDELOAD_REDIRECTS + 1);
    await expectNothingLeftBehind();
  });

  it("follows exactly the allowed number of redirects", async () => {
    let n = 0;
    const env = envWith(() =>
      n < MAX_SIDELOAD_REDIRECTS
        ? new Response(null, { status: 301, headers: { location: `/hop/${++n}` } })
        : new Response("made it"),
    );
    const file = await sideloadFile(env, aliceId, bundleId, { url: "https://files.example/hop/0" });
    expect(file.size).toBe(7);
  });

  it("refuses a redirect to a non-http(s) location", async () => {
    const env = envWith(() => new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }));
    const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/x" }));
    expect(err.code).toBe("bad_gateway");
    expect(requests).toHaveLength(1);
  });

  it("refuses by Content-Length before reading the body", async () => {
    const body = trackedBody(["x".repeat(10)]);
    const env = envWith(
      () => new Response(body.stream, { headers: { "content-length": String(MAX_BYTES + 1) } }),
    );
    const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/big.bin" }));
    expect(err.code).toBe("payload_too_large");
    expect(err.httpStatus).toBe(413);
    expect(body.state.pulled).toBe(0);
    expect(body.state.cancelled).toBe(true);
    await expectNothingLeftBehind();
  });

  it("enforces the size limit mid-stream when no length was declared", async () => {
    const body = trackedBody(Array.from({ length: 50 }, () => "y".repeat(100)));
    const env = envWith(() => new Response(body.stream));
    const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/big.bin" }));
    expect(err.code).toBe("payload_too_large");
    // It stopped reading once over the limit rather than draining the source.
    expect(body.state.pulled).toBeLessThan(15);
    expect(body.state.cancelled).toBe(true);
    await expectNothingLeftBehind();
  });

  it("accepts a file of exactly the maximum size", async () => {
    const env = envWith(() => new Response("z".repeat(MAX_BYTES)));
    expect((await sideloadFile(env, aliceId, bundleId, { url: "https://files.example/edge.bin" })).size).toBe(MAX_BYTES);
  });

  it("checks the MIME allowlist before reading the body", async () => {
    const allowImages = { mimeAllowlist: ["image/*"] };
    const body = trackedBody(["<html>"]);
    const env = envWith(() => new Response(body.stream, { headers: { "content-type": "text/html; charset=utf-8" } }), allowImages);
    const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/page" }));
    expect(err.code).toBe("unsupported_media_type");
    expect(err.httpStatus).toBe(415);
    expect(body.state.pulled).toBe(0);
    await expectNothingLeftBehind();

    // A disallowed type the caller asked for is refused before any request is made.
    requests = [];
    const declared = await failure(
      sideloadFile(envWith(() => new Response("x"), allowImages), aliceId, bundleId, {
        url: "https://files.example/x",
        mime_type: "application/zip",
      }),
    );
    expect(declared.code).toBe("unsupported_media_type");
    expect(requests).toHaveLength(0);

    const ok = await sideloadFile(
      envWith(() => new Response("png", { headers: { "content-type": "IMAGE/PNG" } }), allowImages),
      aliceId,
      bundleId,
      { url: "https://files.example/pic" },
    );
    expect(ok.mimeType).toBe("image/png");
  });

  it("reports a non-2xx upstream by its status and stores nothing", async () => {
    for (const status of [404, 500, 304]) {
      const env = envWith(() => new Response(status === 304 ? null : "nope", { status }));
      const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/missing.txt" }));
      expect(err.code).toBe("bad_gateway");
      expect(err.httpStatus).toBe(502);
      expect(err.message).toContain(String(status));
    }
    await expectNothingLeftBehind();
  });

  it("times out a request that never answers", async () => {
    const env = envWith(() => new Promise<Response>(() => {}), { sideloadTimeoutMs: 80 });
    const t0 = Date.now();
    const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/slow" }));
    expect(err.code).toBe("gateway_timeout");
    expect(err.httpStatus).toBe(504);
    expect(Date.now() - t0).toBeLessThan(2000);
    // The fetch was told to stop.
    expect((requests[0]!.init.signal as AbortSignal).aborted).toBe(true);
    await expectNothingLeftBehind();
  });

  it("times out a resolver that never answers", async () => {
    const env: FileEnv = {
      ...envWith(() => new Response("never"), { sideloadTimeoutMs: 80 }),
      resolver: () => new Promise<string[]>(() => {}),
    };
    const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/slow" }));
    expect(err.code).toBe("gateway_timeout");
    expect(requests).toHaveLength(0);
  });

  it("times out a body that stalls, leaving nothing behind", async () => {
    const body = trackedBody(["first chunk "], { stallAfter: true });
    const env = envWith(() => new Response(body.stream), { sideloadTimeoutMs: 150 });
    const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/stall.bin" }));
    expect(err.code).toBe("gateway_timeout");
    expect(body.state.pulled).toBeGreaterThan(1);
    await expectNothingLeftBehind();
  });

  it("covers the redirect hops and the body with one budget", async () => {
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let n = 0;
    const env = envWith(
      async () => {
        await pause(60);
        return new Response(null, { status: 302, headers: { location: `/hop/${++n}` } });
      },
      { sideloadTimeoutMs: 150 },
    );
    const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/hop/0" }));
    // Three 60 ms hops overrun a 150 ms budget long before the redirect limit.
    expect(err.code).toBe("gateway_timeout");
    expect(requests.length).toBeLessThan(MAX_SIDELOAD_REDIRECTS + 1);
  });

  it("reports a body that breaks off, leaving nothing behind", async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return controller.error(new Error("socket hang up at 10.1.2.3"));
        sent = true;
        controller.enqueue(new TextEncoder().encode("partial"));
      },
    });
    const err = await failure(
      sideloadFile(envWith(() => new Response(stream)), aliceId, bundleId, { url: "https://files.example/cut.bin" }),
    );
    expect(err.code).toBe("bad_gateway");
    expect(err.message).not.toContain("10.1.2.3");
    await expectNothingLeftBehind();
  });

  it("accepts only plain http(s) URLs", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://files.example/a.txt",
      "data:text/plain,hi",
      "not a url",
      "/relative/path",
      "https://user:pass@files.example/a.txt",
    ]) {
      const err = await failure(sideloadFile(envWith(() => new Response("never")), aliceId, bundleId, { url }));
      expect(err.code, url).toBe("invalid_request");
    }
    expect(requests).toHaveLength(0);
    expect(resolved).toHaveLength(0);
  });

  it("requires edit_files, checked before any network activity", async () => {
    const env = envWith(() => new Response("never"));
    const stranger = await failure(sideloadFile(env, bobId, bundleId, { url: "https://files.example/a.txt" }));
    expect(stranger.code).toBe("not_found"); // the bundle's existence is not revealed

    await alice.post(`/v1/bundles/${bundleId}/grants`, { userId: bobId, capabilities: ["read_files"], effect: "allow" });
    const reader = await failure(sideloadFile(env, bobId, bundleId, { url: "https://files.example/a.txt" }));
    expect(reader.code).toBe("forbidden");
    expect((reader.details as { capability: string }).capability).toBe("edit_files");

    expect(requests).toHaveLength(0);
    expect(resolved).toHaveLength(0);
    await expectNothingLeftBehind();
  });

  it("refuses when sideloading is switched off, before anything else", async () => {
    const env = envWith(() => new Response("never"), { sideloadEnabled: false });
    const err = await failure(sideloadFile(env, aliceId, bundleId, { url: "https://files.example/a.txt" }));
    expect(err.code).toBe("forbidden");
    expect(err.message).toBe("sideloading is disabled on this instance");
    expect(requests).toHaveLength(0);
  });

  it("writes the hidden detail to the server log, without the URL's path or query", async () => {
    const lines: string[] = [];
    const env: FileEnv = {
      ...envWith(() => new Response("never")),
      logger: { debug() {}, info() {}, log() {}, error() {}, warn: (...args) => void lines.push(args.join(" ")) },
    };
    await failure(sideloadFile(env, aliceId, bundleId, { url: "http://internal.test/private/path?token=s3cr3t" }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("internal.test");
    expect(lines[0]).not.toContain("s3cr3t");
    expect(lines[0]).not.toContain("/private/path");
  });
});

describe("sideload (transports)", () => {
  let upstream: Server;
  let upstreamUrl: string;
  let hits: Array<{ url: string; headers: Record<string, unknown> }>;

  beforeAll(async () => {
    const port = await getFreePort();
    upstreamUrl = `http://127.0.0.1:${port}`;
    upstream = createServer((req, res) => {
      hits.push({ url: req.url ?? "", headers: req.headers });
      if (req.url === "/files/notes.txt") {
        // Chunked, no Content-Length: the size is only known once it has been read.
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.write("streamed ");
        res.end("notes");
      } else if (req.url === "/go") {
        res.writeHead(302, { location: "/files/notes.txt" }).end();
      } else if (req.url === "/to-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      } else if (req.url === "/huge") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.alloc(MAX_BYTES * 4, 1));
      } else {
        res.writeHead(404).end("nope");
      }
    });
    await new Promise<void>((resolve) => upstream.listen(port, "127.0.0.1", resolve));
  });

  beforeEach(() => {
    hits = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => upstream.close((e) => (e ? reject(e) : resolve())));
  });

  async function boot(env: Record<string, string> = {}) {
    // Loopback is allowlisted so the test upstream is reachable; every other
    // private range is still guarded.
    const app = await bootTestApp({
      YAP_HOOK_ALLOW_HOSTS: "127.0.0.1",
      YAP_MAX_FILE_SIZE_BYTES: String(MAX_BYTES),
      ...env,
    });
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    const alice = apiClient(app.baseUrl, a.body.initialKey.key);
    const aliceMcp = await connectMcp(app.baseUrl, a.body.initialKey.key);
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    const bob = apiClient(app.baseUrl, b.body.initialKey.key);
    const spaceId = (await alice.post("/v1/spaces", { name: "Sideload" })).body.id;
    const bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "assets" })).body.id;
    const callOne = async (tool: string, params: Record<string, unknown>) =>
      (await aliceMcp.call("call", { space_id: spaceId, calls: [{ bundle_id: bundleId, tool, params }] })).results[0];
    return {
      app,
      alice,
      aliceMcp,
      bob,
      bobId: b.body.user.id as string,
      bundleId,
      callOne,
      stop: async () => {
        await aliceMcp.close();
        await app.stop();
      },
    };
  }

  describe("enabled (the default)", () => {
    let t: Awaited<ReturnType<typeof boot>>;
    beforeAll(async () => {
      t = await boot();
    });
    afterAll(async () => {
      await t.stop();
    });

    it("REST and MCP store the same file in the same shape as upload_complete", async () => {
      const rest = await t.alice.post(`/v1/bundles/${t.bundleId}/files/sideload`, { url: `${upstreamUrl}/files/notes.txt` });
      expect(rest.status).toBe(201);
      expect(rest.body).toMatchObject({ name: "notes.txt", mimeType: "text/plain", size: 14, status: "finalized" });

      const mcp = await t.callOne("sideload_file", { url: `${upstreamUrl}/go`, name: "renamed.txt" });
      expect(mcp.ok).toBe(true);
      expect(mcp.result).toMatchObject({ name: "renamed.txt", mimeType: "text/plain", size: 14, status: "finalized" });
      expect(Object.keys(mcp.result).sort()).toEqual(Object.keys(rest.body).sort());

      // The same keys upload_complete answers with.
      const requested = await t.callOne("upload_request", { name: "manual.txt", mime_type: "text/plain" });
      await fetch(requested.result.upload_url, { method: "PUT", body: "manual" });
      const completed = await t.callOne("upload_complete", { file_id: requested.result.file_id });
      expect(Object.keys(mcp.result).sort()).toEqual(Object.keys(completed.result).sort());

      // The bytes really are in the bundle.
      const link = await t.alice.get(`/v1/files/${rest.body.id}/link`);
      expect(await (await fetch(link.body.url)).text()).toBe("streamed notes");
    });

    it("sends the upstream nothing of the caller's", async () => {
      await t.alice.post(`/v1/bundles/${t.bundleId}/files/sideload`, { url: `${upstreamUrl}/files/notes.txt` });
      const { headers } = hits.at(-1)!;
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
    });

    it("rejects params the surface does not offer", async () => {
      const mcp = await t.callOne("sideload_file", {
        url: `${upstreamUrl}/files/notes.txt`,
        headers: { authorization: "Bearer x" },
      });
      expect(mcp.ok).toBe(false);
      expect(mcp.error.code).toBe("invalid_request");
      expect(hits).toHaveLength(0);
    });

    it("blocks a real redirect to a private address on both transports", async () => {
      const rest = await t.alice.post(`/v1/bundles/${t.bundleId}/files/sideload`, { url: `${upstreamUrl}/to-metadata` });
      expect(rest.status).toBe(403);
      expect(rest.body.error.message).not.toContain("169.254");
      const mcp = await t.callOne("sideload_file", { url: `${upstreamUrl}/to-metadata` });
      expect(mcp.ok).toBe(false);
      expect(mcp.error.code).toBe("forbidden");
    });

    it("maps upstream failures and limits to their HTTP statuses", async () => {
      const missing = await t.alice.post(`/v1/bundles/${t.bundleId}/files/sideload`, { url: `${upstreamUrl}/missing` });
      expect(missing.status).toBe(502);
      expect(missing.body.error.message).toContain("404");

      const huge = await t.alice.post(`/v1/bundles/${t.bundleId}/files/sideload`, { url: `${upstreamUrl}/huge` });
      expect(huge.status).toBe(413);

      const bad = await t.alice.post(`/v1/bundles/${t.bundleId}/files/sideload`, { url: "file:///etc/passwd" });
      expect(bad.status).toBe(400);
      const noUrl = await t.alice.post(`/v1/bundles/${t.bundleId}/files/sideload`, { name: "x" });
      expect(noUrl.status).toBe(400);
    });

    it("requires edit_files on both transports", async () => {
      expect((await t.bob.post(`/v1/bundles/${t.bundleId}/files/sideload`, { url: `${upstreamUrl}/files/notes.txt` })).status).toBe(404);
      await t.alice.post(`/v1/bundles/${t.bundleId}/grants`, {
        userId: t.bobId,
        capabilities: ["read_files"],
        effect: "allow",
      });
      const denied = await t.bob.post(`/v1/bundles/${t.bundleId}/files/sideload`, { url: `${upstreamUrl}/files/notes.txt` });
      expect(denied.status).toBe(403);
      expect(denied.body.error.details.capability).toBe("edit_files");
      expect(hits).toHaveLength(0);
    });

    it("advertises sideload_file in the manifest and get_tools", async () => {
      const manifest = (await t.aliceMcp.call("load")).tools.call.second_tier;
      expect(manifest.sideload_file).toMatchObject({ capability: "edit_files", targets: ["bundle"] });
      const spec = (await t.aliceMcp.call("get_tools", { names: ["sideload_file"] })).second_tier.sideload_file;
      expect(spec.params).toEqual({ url: { required: true }, name: {}, mime_type: {} });
      expect(spec.description).toMatch(/direct link to the file itself/);
      const tools = await t.aliceMcp.client.listTools();
      expect(tools.tools.find((tool) => tool.name === "call")!.description).toContain("sideload_file");
    });
  });

  describe("switched off (YAP_SIDELOAD_ENABLED=false)", () => {
    let t: Awaited<ReturnType<typeof boot>>;
    beforeAll(async () => {
      t = await boot({ YAP_SIDELOAD_ENABLED: "false" });
    });
    afterAll(async () => {
      await t.stop();
    });

    it("the REST endpoint refuses and fetches nothing", async () => {
      const res = await t.alice.post(`/v1/bundles/${t.bundleId}/files/sideload`, { url: `${upstreamUrl}/files/notes.txt` });
      expect(res.status).toBe(403);
      expect(res.body.error.message).toBe("sideloading is disabled on this instance");
      expect(hits).toHaveLength(0);
    });

    it("the tool is not offered anywhere, and refuses the same way if called anyway", async () => {
      const manifest = (await t.aliceMcp.call("load")).tools.call.second_tier;
      expect(manifest.sideload_file).toBeUndefined();
      expect(manifest.upload_request).toBeDefined();
      expect((await t.aliceMcp.call("get_tools")).second_tier.sideload_file).toBeUndefined();
      await expect(t.aliceMcp.call("get_tools", { names: ["sideload_file"] })).rejects.toThrow(/unknown second-tier tool/);
      const tools = await t.aliceMcp.client.listTools();
      expect(tools.tools.find((tool) => tool.name === "call")!.description).not.toContain("sideload_file");
      // The "unknown tool" hint does not list it either.
      const typo = await t.callOne("sideload_fil", {});
      expect(typo.error.message).not.toContain("sideload_file");

      const called = await t.callOne("sideload_file", { url: `${upstreamUrl}/files/notes.txt` });
      expect(called.ok).toBe(false);
      expect(called.error).toEqual({ code: "forbidden", message: "sideloading is disabled on this instance" });
      expect(hits).toHaveLength(0);
    });
  });
});
