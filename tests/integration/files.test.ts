/**
 * The file lifecycle on the local-disk adapter: request → upload →
 * complete, mint-on-demand links with TTL expiry, single-use upload links,
 * policy enforcement, immediate blob deletion, and the orphan sweep.
 */
import { eq } from "drizzle-orm";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sweepOrphans } from "../../src/core/files.js";
import { UPLOAD_ERROR_JS, UPLOAD_FINALIZE_JS } from "../../src/widgets/registry.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

interface RawPutResponse {
  status: number;
  body: any;
}

describeEachAdapter("files", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceMcp: McpTestClient;
  let bobRest: ApiClient;
  let bobId: string;
  let bobKey: string;
  let spaceId: string;
  let bundleId: string;

  const callOne = async (client: McpTestClient, tool: string, params: Record<string, unknown>) => {
    const res = await client.call("call", {
      space_id: spaceId,
      calls: [{ bundle_id: bundleId, tool, params }],
    });
    return res.results[0];
  };

  const rawPut = async (
    url: string,
    chunks: Uint8Array[],
    headers: Record<string, string> = {},
  ): Promise<RawPutResponse> =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const req = request(
        target,
        {
          method: "PUT",
          headers,
        },
        (res) => {
          const received: Buffer[] = [];
          res.on("data", (chunk: Buffer) => received.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(received).toString("utf8");
            let body: any = text;
            try {
              body = text ? JSON.parse(text) : null;
            } catch {
              // leave as text
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        },
      );
      req.on("error", reject);
      for (const chunk of chunks) req.write(chunk);
      req.end();
    });

  beforeAll(async () => {
    app = await bootTestApp(
      { YAP_DOWNLOAD_TTL_SECONDS: "2", YAP_MAX_FILE_SIZE_BYTES: "1024" },
      await adapter.makeDb(),
    );
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    aliceMcp = await connectMcp(app.baseUrl, a.body.initialKey.key);
    const b = await sysadmin.post("/v1/users", { name: "Bob" });
    bobRest = apiClient(app.baseUrl, b.body.initialKey.key);
    bobId = b.body.user.id;
    bobKey = b.body.initialKey.key;
    spaceId = (await alice.post("/v1/spaces", { name: "Files" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "assets" })).body.id;
  });

  afterAll(async () => {
    await aliceMcp.close();
    await app.stop();
  });

  it("round-trips: request → PUT bytes → complete → mint link → fetch → TTL expiry", async () => {
    const requested = await callOne(aliceMcp, "upload_request", {
      name: "hello.txt",
      mime_type: "text/plain",
    });
    expect(requested.ok).toBe(true);
    expect(requested._meta.widget).toBe("ui://yap/upload-dropzone");
    expect(requested.result.origin_upload_url).toContain("/w/upload-dropzone?token=");
    const { file_id, upload_url } = requested.result;

    const put = await fetch(upload_url, { method: "PUT", body: "hello yap" });
    expect(put.status).toBe(200);

    const completed = await callOne(aliceMcp, "upload_complete", { file_id });
    expect(completed.ok).toBe(true);
    expect(completed.result.status).toBe("finalized");
    expect(completed.result.size).toBe(9); // read from storage, not declared

    const listed = await callOne(aliceMcp, "list_files", {});
    expect(listed.result.data.some((f: any) => f.id === file_id)).toBe(true);

    const shown = await callOne(aliceMcp, "show_file", { ref: `file://${file_id}` });
    expect(shown.ok).toBe(true);
    expect(shown._meta.widget).toBe("ui://yap/media-card");
    expect(shown.result.kind).toBe("file");
    expect(shown.result.expires_in).toBe(2);
    const download = await fetch(shown.result.url);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("hello yap");
    expect(download.headers.get("content-type")).toContain("text/plain");
    // The preview url renders inline; show_file also returns a dedicated
    // attachment link (download_url) so the media-card's Download action saves
    // the file instead of previewing it.
    expect(download.headers.get("content-disposition")).toMatch(/^inline/);
    const forced = await fetch(shown.result.download_url);
    expect(forced.status).toBe(200);
    expect(forced.headers.get("content-disposition")).toMatch(/^attachment/);

    // The link stops working after its TTL (configured to 2s here).
    await new Promise((r) => setTimeout(r, 2200));
    expect((await fetch(shown.result.url)).status).toBe(401);
    // Re-access means re-minting: a fresh link works.
    const fresh = await alice.get(`/v1/files/${file_id}/link`);
    expect((await fetch(fresh.body.url)).status).toBe(200);
  });

  it("upload links are single-use", async () => {
    const requested = (await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "once.txt" }))
      .body;
    expect((await fetch(requested.upload_url, { method: "PUT", body: "first" })).status).toBe(200);
    expect((await fetch(requested.upload_url, { method: "PUT", body: "second" })).status).toBe(409);
  });

  it("rejects uploads beyond the configured max size (1KB here)", async () => {
    const requested = (await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "big.bin" }))
      .body;
    const tooBig = new Uint8Array(2048);
    // Oversized bytes are 413 Payload Too Large; the rejected PUT never stored
    // anything, so completing then fails with 400 (no uploaded bytes).
    expect((await fetch(requested.upload_url, { method: "PUT", body: tooBig })).status).toBe(413);
    expect((await alice.post(`/v1/files/${requested.file_id}/complete`, {})).status).toBe(400);
    // Declared-size pre-check rejects at request time too — also 413.
    const declared = await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, {
      name: "big.bin",
      size: 999999,
    });
    expect(declared.status).toBe(413);
  });

  it("accepts chunked uploads without content-length when under the configured max", async () => {
    const requested = (await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "chunked-ok.bin" }))
      .body;
    const put = await rawPut(requested.upload_url, [Buffer.from("hello "), Buffer.from("chunked")], {
      "transfer-encoding": "chunked",
    });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ uploaded: true, size: 13 });

    const completed = await alice.post(`/v1/files/${requested.file_id}/complete`, {});
    expect(completed.status).toBe(200);
    expect(completed.body.size).toBe(13);
  });

  it("rejects chunked uploads once streaming bytes exceed the configured max", async () => {
    const requested = (await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "chunked-big.bin" }))
      .body;
    const put = await rawPut(requested.upload_url, [new Uint8Array(768), new Uint8Array(257)], {
      "transfer-encoding": "chunked",
    });
    expect(put.status).toBe(413);
    expect(put.body.error).toEqual({
      code: "payload_too_large",
      message: "file exceeds the maximum size of 1024 bytes",
    });

    const completed = await alice.post(`/v1/files/${requested.file_id}/complete`, {});
    expect(completed.status).toBe(400);
  });

  it("rejects malformed content-length headers before upload storage", async () => {
    const requested = (await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "bad-length.bin" }))
      .body;
    const put = await rawPut(requested.upload_url, [Buffer.from("x")], { "content-length": "01" });
    expect(put.status).toBe(400);
    expect(put.body.error).toEqual({
      code: "invalid_request",
      message: "invalid content-length header",
    });

    const completed = await alice.post(`/v1/files/${requested.file_id}/complete`, {});
    expect(completed.status).toBe(400);
  });

  it("enforces the MIME allowlist when configured", async () => {
    // Config-level behavior, adapter-independent — boot an isolated app
    // (sqlite in-memory) rather than truncating the shared adapter database.
    const restricted = await bootTestApp({ YAP_MIME_ALLOWLIST: "image/*, text/plain" });
    try {
      const sysadmin = apiClient(restricted.baseUrl, TEST_SYSADMIN_KEY);
      const u = await sysadmin.post("/v1/users", { name: "U" });
      const user = apiClient(restricted.baseUrl, u.body.initialKey.key);
      const sid = (await user.post("/v1/spaces", { name: "S" })).body.id;
      const bid = (await user.post(`/v1/spaces/${sid}/bundles`, { name: "b" })).body.id;
      const okImage = await user.post(`/v1/bundles/${bid}/files/upload-request`, {
        name: "x.png",
        mime_type: "image/png",
      });
      expect(okImage.status).toBe(201);
      const badZip = await user.post(`/v1/bundles/${bid}/files/upload-request`, {
        name: "x.zip",
        mime_type: "application/zip",
      });
      expect(badZip.status).toBe(415);
      expect(badZip.body.error).toMatchObject({
        code: "unsupported_media_type",
        details: { allowed: ["image/*", "text/plain"] },
      });
    } finally {
      await restricted.stop();
    }
  });

  it("completing without uploaded bytes fails; completing twice conflicts", async () => {
    const requested = (await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "ghost.txt" }))
      .body;
    const premature = await alice.post(`/v1/files/${requested.file_id}/complete`, {});
    expect(premature.status).toBe(400);
    await fetch(requested.upload_url, { method: "PUT", body: "now" });
    expect((await alice.post(`/v1/files/${requested.file_id}/complete`, {})).status).toBe(200);
    expect((await alice.post(`/v1/files/${requested.file_id}/complete`, {})).status).toBe(409);
  });

  it("deleting a file removes the record and the blob immediately", async () => {
    const requested = (await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "doomed.txt" }))
      .body;
    await fetch(requested.upload_url, { method: "PUT", body: "bye" });
    await alice.post(`/v1/files/${requested.file_id}/complete`, {});
    const link = (await alice.get(`/v1/files/${requested.file_id}/link`)).body;

    const storageKey = (
      await app.db.client.select().from(app.db.tables.files).where(eq(app.db.tables.files.id, requested.file_id))
    )[0]!.storageKey;
    expect(await app.blob.stat(storageKey)).not.toBeNull();

    expect((await alice.delete(`/v1/files/${requested.file_id}`)).status).toBe(200);
    expect(await app.blob.stat(storageKey)).toBeNull(); // blob gone immediately
    expect((await alice.get(`/v1/files/${requested.file_id}/link`)).status).toBe(404);
    expect((await fetch(link.url)).status).toBe(404); // even unexpired links die with the record
  });

  it("deleting a bundle deletes its files' blobs too (not just the records)", async () => {
    const tempBundle = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "ephemeral-assets" })).body.id;
    const f = (await alice.post(`/v1/bundles/${tempBundle}/files/upload-request`, { name: "doc.txt" })).body;
    await fetch(f.upload_url, { method: "PUT", body: "bundle-scoped bytes" });
    await alice.post(`/v1/files/${f.file_id}/complete`, {});
    const storageKey = (
      await app.db.client.select().from(app.db.tables.files).where(eq(app.db.tables.files.id, f.file_id))
    )[0]!.storageKey;
    expect(await app.blob.stat(storageKey)).not.toBeNull();

    expect((await alice.delete(`/v1/bundles/${tempBundle}`)).status).toBe(200);
    // Record cascaded away AND the blob bytes were removed (no orphan).
    const rows = await app.db.client
      .select()
      .from(app.db.tables.files)
      .where(eq(app.db.tables.files.id, f.file_id));
    expect(rows).toEqual([]);
    expect(await app.blob.stat(storageKey)).toBeNull();
  });

  it("rejects file names with control characters (CR/LF header-injection vector)", async () => {
    const bad = await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, {
      name: "a\r\nSet-Cookie: x=1.txt",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/control characters/);
  });

  it("sweeps never-uploaded reserved placeholders past the age cutoff", async () => {
    // A reserved record whose upload never landed (no PUT).
    const orphan = (await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "orphan.txt" })).body;
    const { files } = app.db.tables;
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await app.db.client.update(files).set({ createdAt: old }).where(eq(files.id, orphan.file_id));

    const swept = await sweepOrphans({ db: app.db, blob: app.blob, config: app.config }, 30 * 60 * 1000);
    expect(swept).toBe(1);
    const rows = await app.db.client.select().from(files).where(eq(files.id, orphan.file_id));
    expect(rows).toEqual([]);
    // Finalized files are never swept.
    await sweepOrphans({ db: app.db, blob: app.blob, config: app.config }, 0);
    const remaining = await app.db.client.select().from(files).where(eq(files.status, "finalized"));
    expect(remaining.length).toBeGreaterThan(0);
  });

  it("never sweeps a reserved record whose bytes were already uploaded (awaiting finalize)", async () => {
    const uploaded = (await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "pending.txt" }))
      .body;
    await fetch(uploaded.upload_url, { method: "PUT", body: "successfully uploaded, finalize delayed" });
    const { files } = app.db.tables;
    // Age it well past the cutoff: it still must survive — destroying it would
    // silently lose a file the user successfully uploaded.
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await app.db.client.update(files).set({ createdAt: old }).where(eq(files.id, uploaded.file_id));

    const swept = await sweepOrphans({ db: app.db, blob: app.blob, config: app.config }, 1);
    expect(swept).toBe(0);
    const rows = await app.db.client.select().from(files).where(eq(files.id, uploaded.file_id));
    expect(rows).toHaveLength(1);
    // And a delayed finalize still works, returning the uploaded bytes' size.
    const completed = await alice.post(`/v1/files/${uploaded.file_id}/complete`, {});
    expect(completed.status).toBe(200);
    expect(completed.body.size).toBe(39);
  });

  const uploadFinalized = async (name: string, body = "bytes") => {
    const requested = (await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name })).body;
    await fetch(requested.upload_url, { method: "PUT", body });
    expect((await alice.post(`/v1/files/${requested.file_id}/complete`, {})).status).toBe(200);
    return requested.file_id as string;
  };

  it("renames a finalized file over REST, returning it as list_files shows it", async () => {
    const fileId = await uploadFinalized("IMG_0246.txt", "workout");
    const renamed = await alice.patch(`/v1/files/${fileId}`, { name: "  squat-form.txt " });
    expect(renamed.status).toBe(200);
    const listed = (await alice.get(`/v1/bundles/${bundleId}/files`)).body.data.find((f: any) => f.id === fileId);
    expect(renamed.body).toEqual(listed);
    expect(listed.name).toBe("squat-form.txt"); // trimmed, as at upload
    expect(listed.status).toBe("finalized");

    // Only the record changed: the same file:// reference resolves to the same bytes.
    const shown = await callOne(aliceMcp, "show_file", { ref: `file://${fileId}` });
    expect(shown.result.name).toBe("squat-form.txt");
    expect(await (await fetch(shown.result.url)).text()).toBe("workout");
  });

  it("renames over MCP with update_file; links minted afterwards carry the new filename", async () => {
    const fileId = await uploadFinalized("4f1c9e2a.txt", "hello");
    const renamed = await callOne(aliceMcp, "update_file", { id: fileId, name: "notes.txt" });
    expect(renamed.ok).toBe(true);
    expect(renamed.result).toMatchObject({ id: fileId, name: "notes.txt", status: "finalized", size: 5 });

    const link = (await alice.get(`/v1/files/${fileId}/link`)).body;
    expect(link.name).toBe("notes.txt");
    const inline = await fetch(link.url);
    expect(inline.headers.get("content-disposition")).toBe('inline; filename="notes.txt"');
    const shown = await callOne(aliceMcp, "show_file", { ref: `file://${fileId}` });
    const saved = await fetch(shown.result.download_url);
    expect(saved.headers.get("content-disposition")).toBe('attachment; filename="notes.txt"');
  });

  it("renames a reserved file, and finalizing keeps that name", async () => {
    const requested = (await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "draft.txt" })).body;
    const renamed = await alice.patch(`/v1/files/${requested.file_id}`, { name: "final.txt" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.status).toBe("reserved");
    await fetch(requested.upload_url, { method: "PUT", body: "x" });
    const completed = await alice.post(`/v1/files/${requested.file_id}/complete`, {});
    expect(completed.body.name).toBe("final.txt");
  });

  it("rejects invalid names on rename and leaves the old name in place", async () => {
    const fileId = await uploadFinalized("keep.txt");
    for (const name of ["", "   ", "a\r\nSet-Cookie: x", "dir/evil.txt", "dir\\evil.txt", "x".repeat(256)]) {
      const res = await alice.patch(`/v1/files/${fileId}`, { name });
      expect(res.status, JSON.stringify(name)).toBe(400);
    }
    expect((await alice.patch(`/v1/files/${fileId}`, {})).status).toBe(400);
    expect((await alice.patch(`/v1/files/${fileId}`, { name: 42 })).status).toBe(400);
    const viaMcp = await callOne(aliceMcp, "update_file", { id: fileId, name: "a/b" });
    expect(viaMcp.ok).toBe(false);
    expect(viaMcp.error.code).toBe("invalid_request");
    expect((await alice.get(`/v1/files/${fileId}/link`)).body.name).toBe("keep.txt");
    expect((await alice.patch(`/v1/files/00000000-0000-0000-0000-000000000000`, { name: "x.txt" })).status).toBe(404);
  });

  it("rename requires edit_files, over REST and MCP", async () => {
    const fileId = await uploadFinalized("guarded.txt");
    // A non-member cannot even see the file, as with delete.
    expect((await bobRest.patch(`/v1/files/${fileId}`, { name: "mine.txt" })).status).toBe(404);
    const grant = await alice.post(`/v1/bundles/${bundleId}/grants`, {
      userId: bobId,
      capabilities: ["read_files"],
      effect: "allow",
    });
    const denied = await bobRest.patch(`/v1/files/${fileId}`, { name: "mine.txt" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.capability).toBe("edit_files");
    const bobMcp = await connectMcp(app.baseUrl, bobKey);
    try {
      const viaMcp = await callOne(bobMcp, "update_file", { id: fileId, name: "mine.txt" });
      expect(viaMcp.ok).toBe(false);
      expect(viaMcp.error.code).toBe("forbidden");
    } finally {
      await bobMcp.close();
      await alice.delete(`/v1/bundles/${bundleId}/grants/${grant.body.data[0].id}`);
    }
    expect((await alice.get(`/v1/files/${fileId}/link`)).body.name).toBe("guarded.txt");
  });

  it("the upload dropzone keeps the name given to upload_request", async () => {
    // Replays the widget's own finalize body (UPLOAD_FINALIZE_JS) against the real endpoint.
    const finalizeBody = new Function(UPLOAD_FINALIZE_JS + " return finalizeBody;")() as (
      d: Record<string, unknown>,
      file: { name: string; type?: string },
    ) => Record<string, unknown>;
    const browserFile = { name: "IMG_0246.txt", type: "text/plain" };
    const finalizeWith = async (data: Record<string, unknown>) => {
      await fetch(data.upload_url as string, { method: "PUT", body: "pic" });
      const res = await fetch(data.complete_url as string, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(finalizeBody(data, browserFile)),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as any).name;
    };

    const requested = await callOne(aliceMcp, "upload_request", { name: "workout-reference.txt" });
    expect(requested._meta.data.name).toBe("workout-reference.txt");
    expect(await finalizeWith(requested._meta.data)).toBe("workout-reference.txt");

    // Data without a name (a caller that left it out) falls back to the browser's filename.
    const bare = await callOne(aliceMcp, "upload_request", { name: "placeholder.txt" });
    const { name: _dropped, ...noName } = bare._meta.data;
    expect(await finalizeWith(noName)).toBe("IMG_0246.txt");
  });

  it("show_file passes direct URLs through without minting", async () => {
    const shown = await callOne(aliceMcp, "show_file", { ref: "https://example.com/cat.png" });
    expect(shown.ok).toBe(true);
    expect(shown.result.url).toBe("https://example.com/cat.png");
    expect(shown.result.expires_in).toBeUndefined();
  });

  it("file access reuses the capability model: read_files vs edit_files", async () => {
    await alice.post(`/v1/bundles/${bundleId}/grants`, {
      userId: bobId,
      capabilities: ["read_files"],
      effect: "allow",
    });
    expect((await bobRest.get(`/v1/bundles/${bundleId}/files`)).status).toBe(200);
    const denied = await bobRest.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "nope.txt" });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.capability).toBe("edit_files");

    const fileId = (await bobRest.get(`/v1/bundles/${bundleId}/files`)).body.data[0]?.id;
    if (fileId) {
      expect((await bobRest.get(`/v1/files/${fileId}/link`)).status).toBe(200);
      expect((await bobRest.delete(`/v1/files/${fileId}`)).status).toBe(403);
    }
  });
});

/**
 * The upload-dropzone's friendly errors are pinned to the HTTP status contract,
 * not to server message text: real REST rejections are fed through the exact
 * classifier the widget ships (UPLOAD_ERROR_JS). If the server stopped returning
 * 413/415 — or the widget stopped keying on them — these break, which is the
 * coupling that message-text matching left untested.
 */
describe("upload-dropzone error classification (server contract ↔ widget)", () => {
  const explainUploadFailure = new Function(UPLOAD_ERROR_JS + " return explainUploadFailure;")() as (
    stage: string,
    status: number,
    contentType: string,
    body: string,
    file: { name?: string; type?: string; size?: number },
  ) => { message: string; retry: boolean };

  let app: TestApp;
  let user: ApiClient;
  let bundleId: string;

  beforeAll(async () => {
    app = await bootTestApp({ YAP_MAX_FILE_SIZE_BYTES: "1024", YAP_MIME_ALLOWLIST: "image/*, text/plain" });
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const u = await sysadmin.post("/v1/users", { name: "U" });
    user = apiClient(app.baseUrl, u.body.initialKey.key);
    const sid = (await user.post("/v1/spaces", { name: "S" })).body.id;
    bundleId = (await user.post(`/v1/spaces/${sid}/bundles`, { name: "b" })).body.id;
  });

  afterAll(async () => {
    await app.stop();
  });

  const readRaw = async (res: Response) => ({
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    body: await res.text(),
  });

  it("turns a real 413 from the upload PUT into a retryable 'too large' message", async () => {
    const requested = (await user.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "big.bin" })).body;
    const res = await readRaw(await fetch(requested.upload_url, { method: "PUT", body: new Uint8Array(2048) }));
    expect(res.status).toBe(413);
    const explained = explainUploadFailure("upload", res.status, res.contentType, res.body, {
      name: "big.bin",
      size: 2048,
    });
    expect(explained.message).toContain("The selected file is too large.");
    expect(explained.message).toContain("Selected file size: 2.0 KB.");
    // An upload-stage size rejection never consumes the single-use link, so the
    // same link can still take a smaller file — the picker is re-offered.
    expect(explained.retry).toBe(true);
  });

  it("turns a real 415 from finalize into a terminal 'type not accepted' message", async () => {
    const requested = (await user.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "note.txt" })).body;
    expect((await fetch(requested.upload_url, { method: "PUT", body: "hello" })).status).toBe(200);
    const res = await readRaw(
      await fetch(requested.complete_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "note.txt", mime_type: "application/zip" }),
      }),
    );
    expect(res.status).toBe(415);
    const explained = explainUploadFailure("finalize", res.status, res.contentType, res.body, {
      name: "note.txt",
      type: "application/zip",
    });
    expect(explained.message).toContain("The selected file type is not accepted (application/zip).");
    expect(explained.message).toContain("Accepted types: image/*, text/plain.");
    expect(explained.message).toContain("Request a fresh upload link to choose another file.");
    // Bytes already uploaded and the link is spent; no in-place retry.
    expect(explained.retry).toBe(false);
  });
});
