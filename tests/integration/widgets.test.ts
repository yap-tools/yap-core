/**
 * Widgets: the ui:// registry, result-level delivery on call, the
 * show_widget shell, and origin-hosted pages with signed expiring tokens.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WIDGETS } from "../../src/widgets/registry.js";
import { describeEachAdapter } from "../helpers/adapters.js";
import { apiClient, type ApiClient } from "../helpers/api.js";
import { bootTestApp, TEST_SYSADMIN_KEY, type TestApp } from "../helpers/app.js";
import { connectMcp, type McpTestClient } from "../helpers/mcp.js";

function extractEmbeddedData(html: string): any {
  const match = /window\.__YAP_DATA__ = (.*?);<\/script>/s.exec(html);
  expect(match, "origin page should embed data").toBeTruthy();
  return JSON.parse(match![1]!);
}

describeEachAdapter("widgets", (adapter) => {
  let app: TestApp;
  let alice: ApiClient;
  let aliceMcp: McpTestClient;
  let spaceId: string;
  let bundleId: string;

  beforeAll(async () => {
    app = await bootTestApp({}, await adapter.makeDb());
    const sysadmin = apiClient(app.baseUrl, TEST_SYSADMIN_KEY);
    const a = await sysadmin.post("/v1/users", { name: "Alice" });
    alice = apiClient(app.baseUrl, a.body.initialKey.key);
    aliceMcp = await connectMcp(app.baseUrl, a.body.initialKey.key);
    spaceId = (await alice.post("/v1/spaces", { name: "W" })).body.id;
    bundleId = (await alice.post(`/v1/spaces/${spaceId}/bundles`, { name: "media" })).body.id;
  });

  afterAll(async () => {
    await aliceMcp.close();
    await app.stop();
  });

  describe("the ui:// registry", () => {
    it("registers every widget as a readable ui:// resource", async () => {
      const resources = await aliceMcp.client.listResources();
      const uris = resources.resources.map((r) => r.uri);
      expect(uris).toContain("ui://yap/shell");
      expect(uris).toContain("ui://yap/upload-dropzone");
      expect(uris).toContain("ui://yap/media-card");

      const card = await aliceMcp.client.readResource({ uri: "ui://yap/media-card" });
      const html = (card.contents[0] as any).text as string;
      // MCP Apps (SEP-1865) profile so hosts treat it as a renderable app.
      expect((card.contents[0] as any).mimeType).toBe("text/html;profile=mcp-app");
      expect(html).toContain("<!doctype html>");
      // MCP Apps bridge inlined: the initialize handshake + size notification.
      expect(html).toContain("ui/initialize");
      expect(html).toContain("ui/notifications/size-changed");
      expect(html).toContain("ui/notifications/tool-result");
    });

    it("widgets are self-contained: no external scripts, styles, or fonts", async () => {
      for (const name of Object.keys(WIDGETS)) {
        const res = await aliceMcp.client.readResource({ uri: `ui://yap/${name}` });
        const html = (res.contents[0] as any).text as string;
        expect(html, name).not.toMatch(/<script[^>]+src=/i);
        expect(html, name).not.toMatch(/<link[^>]+href=/i);
        expect(html, name).not.toMatch(/@import/i);
        expect(html, name).not.toMatch(/url\(\s*['"]?https?:/i);
      }
    });
  });

  describe("result-level delivery via call", () => {
    it("carries the widget pointer in-band, and emits ONLY text content (portable to every client)", async () => {
      const raw: any = await aliceMcp.callRaw("call", {
        space_id: spaceId,
        calls: [{ bundle_id: bundleId, tool: "upload_request", params: { name: "x.txt" } }],
      });
      expect(raw.isError).toBeFalsy();
      const text = raw.content.find((c: any) => c.type === "text").text;
      const parsed = JSON.parse(text);
      expect(parsed.results[0]._meta.widget).toBe("ui://yap/upload-dropzone");
      expect(parsed.results[0]._meta.data.upload_url).toContain("/upload?token=");
      // The widget needs complete_url to finalize after the PUT — omitting it
      // strands every in-client upload in 'reserved'.
      expect(parsed.results[0]._meta.data.complete_url).toContain("/complete?token=");
      // No resource_link (or any non-text) content item: it's an MCP 2025-06-18
      // type that older clients reject, invalidating the whole CallToolResult.
      expect(raw.content.every((c: any) => c.type === "text")).toBe(true);
    });

    it("an in-client widget upload finalizes using the widget data alone", async () => {
      // Replays exactly what the upload-dropzone's inline JS does with _meta.data.
      const raw: any = await aliceMcp.callRaw("call", {
        space_id: spaceId,
        calls: [{ bundle_id: bundleId, tool: "upload_request", params: { name: "widget.txt" } }],
      });
      const data = JSON.parse(raw.content.find((c: any) => c.type === "text").text).results[0]._meta.data;
      const put = await fetch(data.upload_url, { method: "PUT", body: "from the widget" });
      expect(put.status).toBe(200);
      const complete = await fetch(data.complete_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "widget.txt", mime_type: "text/plain" }),
      });
      expect(complete.status).toBe(200);
      const finalized: any = await complete.json();
      expect(finalized.status).toBe("finalized");
    });
  });

  describe("show_widget (the shell)", () => {
    it("statically declares the shell template for MCP Apps prefetch, with a CSP for the origins widgets touch", async () => {
      const tools = await aliceMcp.client.listTools();
      const showWidget = tools.tools.find((t) => t.name === "show_widget")!;
      const ui = (showWidget._meta as any)?.ui;
      expect(ui?.resourceUri).toBe("ui://yap/shell");
      // The widget mounts in the shell's own document, so the host must let the
      // shell reach the server's origin (media bytes, upload PUT/finalize).
      const origin = new URL(app.baseUrl).origin;
      expect(ui?.csp?.connectDomains).toContain(origin);
      expect(ui?.csp?.resourceDomains).toContain(origin);
    });

    it("renders any registered widget by name: text content + structuredContent for MCP Apps", async () => {
      const raw: any = await aliceMcp.callRaw("show_widget", {
        widget: "media-card",
        params: { kind: "image", url: "https://example.com/x.png" },
      });
      // Portable text content (no resource_link) for any client.
      const text = JSON.parse(raw.content.find((c: any) => c.type === "text").text);
      expect(text.widget).toBe("ui://yap/media-card");
      expect(text.params.kind).toBe("image");
      expect(raw.content.every((c: any) => c.type === "text")).toBe(true);
      // MCP Apps render channel: the host forwards structuredContent to the shell
      // as ui/notifications/tool-result. It carries the target widget, its params,
      // and the chosen widget's style + render so the shell mounts it in-place —
      // no nested iframe (which strict hosts leave blank), no resources/read.
      expect(raw.structuredContent.widget).toBe("ui://yap/media-card");
      expect(raw.structuredContent.params.kind).toBe("image");
      expect(raw.structuredContent.render).toBe(WIDGETS["media-card"]!.render);
      expect(raw.structuredContent.style).toBe(WIDGETS["media-card"]!.style);
    });

    it("rejects unknown widgets with the registry listed", async () => {
      await expect(aliceMcp.call("show_widget", { widget: "nope" })).rejects.toThrow(/shell|upload-dropzone/);
    });
  });

  describe("CORS at the edge (cross-origin widget upload)", () => {
    it("answers a null-origin preflight and lets the dropzone PUT/finalize cross-origin", async () => {
      const requested = (
        await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "cors.txt" })
      ).body;

      // A sandboxed widget iframe sends Origin: null and preflights the PUT.
      // The edge must answer it (fastmcp's transport crashes on a null origin).
      const preflight = await fetch(requested.upload_url, {
        method: "OPTIONS",
        headers: {
          origin: "null",
          "access-control-request-method": "PUT",
          "access-control-request-headers": "content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");

      // Both the PUT and the finalize carry allow-origin so the browser accepts them.
      const put = await fetch(requested.upload_url, {
        method: "PUT",
        headers: { origin: "null", "content-type": "text/plain" },
        body: "cors bytes",
      });
      expect(put.status).toBe(200);
      expect(put.headers.get("access-control-allow-origin")).toBe("*");
      const complete = await fetch(requested.complete_url, {
        method: "POST",
        headers: { origin: "null", "content-type": "application/json" },
        body: JSON.stringify({ name: "cors.txt", mime_type: "text/plain" }),
      });
      expect(complete.status).toBe(200);
      expect(complete.headers.get("access-control-allow-origin")).toBe("*");
      expect(((await complete.json()) as any).status).toBe("finalized");
    });

    it("preserves the MCP path through the edge (tools still work)", async () => {
      const loaded = await aliceMcp.call("load", {});
      expect(Array.isArray(loaded.spaces)).toBe(true);
    });
  });


  describe("origin-hosted pages", () => {
    it("serves the upload page at a signed URL and the embedded flow finalizes the file", async () => {
      const requested = (
        await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "via-origin.txt" })
      ).body;
      const page = await fetch(requested.origin_upload_url);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      expect(html).toContain('data-yap-mode="origin"');

      // Simulate exactly what the page's inline JS does with its embedded data.
      const data = extractEmbeddedData(html);
      expect(data.file_id).toBe(requested.file_id);
      const put = await fetch(data.upload_url, { method: "PUT", body: "origin bytes" });
      expect(put.status).toBe(200);
      const complete = await fetch(data.complete_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "picked.txt", mime_type: "text/plain" }),
      });
      expect(complete.status).toBe(200);
      const finalized: any = await complete.json();
      expect(finalized.status).toBe("finalized");
      expect(finalized.size).toBe(12);
      expect(finalized.name).toBe("picked.txt");

      // No event channel: the effect landed in the system; the agent observes state.
      const listed = await alice.get(`/v1/bundles/${bundleId}/files`);
      expect(listed.body.data.some((f: any) => f.id === requested.file_id)).toBe(true);
    });

    it("serves the media-card view page from show_file's origin link", async () => {
      const requested = (
        await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "pic.png" })
      ).body;
      await fetch(requested.upload_url, { method: "PUT", body: "png-ish bytes" });
      await alice.post(`/v1/files/${requested.file_id}/complete`, { mime_type: "image/png" });

      const shown = await aliceMcp.call("call", {
        space_id: spaceId,
        calls: [{ bundle_id: bundleId, tool: "show_file", params: { ref: `file://${requested.file_id}` } }],
      });
      const result = shown.results[0].result;
      expect(result.kind).toBe("image");
      expect(result.origin_view_url).toContain("/w/media-card?token=");

      const page = await fetch(result.origin_view_url);
      expect(page.status).toBe(200);
      const data = extractEmbeddedData(await page.text());
      expect(data.kind).toBe("image");
      expect((await fetch(data.url)).status).toBe(200); // fresh link minted at serve time
    });

    it("rejects missing, invalid, and wrong-widget tokens", async () => {
      expect((await fetch(`${app.baseUrl}/w/upload-dropzone`)).status).toBe(401);
      expect((await fetch(`${app.baseUrl}/w/upload-dropzone?token=garbage`)).status).toBe(401);
      // A media-card token does not open the upload page.
      const requested = (
        await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "t.txt" })
      ).body;
      const uploadToken = new URL(requested.origin_upload_url).searchParams.get("token")!;
      expect((await fetch(`${app.baseUrl}/w/media-card?token=${uploadToken}`)).status).toBe(401);
    });

    it("the shell cannot be origin-hosted (host-dependent by design)", async () => {
      expect((await fetch(`${app.baseUrl}/w/shell?token=garbage`)).status).toBe(400);
    });

    it("upload pages close once the upload is consumed", async () => {
      const requested = (
        await alice.post(`/v1/bundles/${bundleId}/files/upload-request`, { name: "once.txt" })
      ).body;
      await fetch(requested.upload_url, { method: "PUT", body: "x" });
      const reopened = await fetch(requested.origin_upload_url);
      expect(reopened.status).toBe(409);
    });
  });
});
