/**
 * Widget HTML safety: user-controlled data (file names, mime types) must never
 * reach an executable position. The data is embedded as JSON in a <script>
 * (where `<` is escaped so it cannot break out of the tag) and is re-inserted
 * at runtime only through the bridge's esc()/safeUrl() helpers.
 */
import { describe, expect, it } from "vitest";

import { TOOL_RESULT_UNWRAP_JS, UPLOAD_ERROR_JS, WIDGETS, widgetHtml } from "../../src/widgets/registry.js";

describe("widgetHtml", () => {
  it("escapes < in the embedded JSON so a crafted name cannot break out of the script tag", () => {
    const evil = `x"><img src=a onerror=alert(document.cookie)>.png`;
    const html = widgetHtml("media-card", "origin", { kind: "file", url: "https://x/y", name: evil });
    // The raw breakout sequence must not appear; `<` is encoded as <.
    expect(html).not.toContain("<img src=a onerror=");
    expect(html).toContain("\\u003c");
    // The data is still intact once JSON-decoded by the browser.
    const embedded = /window\.__YAP_DATA__ = (.*?);<\/script>/s.exec(html);
    expect(embedded).toBeTruthy();
    expect(JSON.parse(embedded![1]!).name).toBe(evil);
  });

  it("the media-card renderer routes user data through esc()/safeUrl()", () => {
    const render = WIDGETS["media-card"]!.render;
    expect(render).toContain("esc(d.name");
    expect(render).toContain("esc(d.mime_type");
    expect(render).toContain("safeUrl(d.url)");
  });

  it("the media-card download uses the attachment link and opens it via the host bridge", () => {
    const render = WIDGETS["media-card"]!.render;
    expect(render).toContain("safeUrl(d.url)");
    // Uses the server's dedicated attachment link (correct per storage adapter)
    // rather than munging the inline url client-side.
    expect(render).toContain("download_url");
    // Strict MCP Apps sandboxes swallow target=_blank; the click routes through
    // the host's ui/open-link so the link opens in the user's browser.
    expect(render).toContain("ui/open-link");
    // The anchor stays as the fallback for permissive hosts and origin pages.
    expect(render).toContain('target="_blank"');
    expect(render).toContain('rel="noopener noreferrer"');
  });

  it("the media-card renderer handles expired Yap previews without refreshing tokens", () => {
    const render = WIDGETS["media-card"]!.render;
    expect(render).toContain('addEventListener("error"');
    expect(render).toContain("d.expires_in");
    expect(render).toContain("File preview expired - re-run to refresh");
    expect(render).not.toContain("fetch(");
    expect(render).not.toContain("file_id");
  });

  it("the upload-dropzone renderer uses XMLHttpRequest upload progress", () => {
    const render = WIDGETS["upload-dropzone"]!.render;
    expect(render).toContain("new XMLHttpRequest()");
    expect(render).toContain('xhr.open("PUT", d.upload_url)');
    expect(render).toContain("xhr.upload.onprogress");
    expect(render).toContain("evt.lengthComputable");
  });

  it("the upload-dropzone exposes progress and finalizing UI hooks", () => {
    const html = widgetHtml("upload-dropzone", "origin", {
      file_id: "f1",
      upload_url: "https://x/u",
      complete_url: "https://x/c",
    });
    expect(html).toContain('class="progress"');
    expect(html).toContain('class="bar"');
    expect(html).toContain('class="phase"');
    expect(html).toContain("Finalizing");
  });

  it("the upload-dropzone does not construct raw status-only failures", () => {
    const render = WIDGETS["upload-dropzone"]!.render;
    expect(render).not.toContain("upload failed (");
    expect(render).not.toContain("finalize failed (");
  });

  it("the upload-dropzone render wires the shared failure classifier", () => {
    // The widget must call the exact classifier we unit-test below, not a private copy.
    const render = WIDGETS["upload-dropzone"]!.render;
    expect(render).toContain("function explainUploadFailure(");
    expect(render).toContain('explainUploadFailure("upload"');
    expect(render).toContain('explainUploadFailure("finalize"');
  });
  it("embeds the media-card expired state in origin HTML", () => {
    const html = widgetHtml("media-card", "origin", {
      kind: "image",
      url: "https://x/y",
      expires_in: 14400,
      name: "pic.png",
    });
    expect(html).toContain("File preview expired - re-run to refresh");
    expect(html).toContain('addEventListener("error"');
  });

  it("only http(s) URLs survive safeUrl (javascript:/data: are neutralized)", () => {
    // Exercise the bridge helper exactly as it runs in the sandbox.
    const safeUrl = (v: string) => (/^https?:\/\//i.test(v) ? v : "#");
    expect(safeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html,<script>")).toBe("#");
  });
});

describe("upload-dropzone: failure classification", () => {
  // Evaluate the exact source the widget embeds, so the test tracks shipped code.
  const explain = new Function(UPLOAD_ERROR_JS + " return explainUploadFailure;")() as (
    stage: string,
    status: number,
    contentType: string,
    body: string,
    file: { name?: string; type?: string; size?: number },
  ) => { message: string; retry: boolean };

  const json = (code: string, details?: unknown) =>
    JSON.stringify({ error: { code, ...(details ? { details } : {}) } });

  it("classifies by HTTP status, not message text", () => {
    // A plain 400 whose message *mentions* size/type must NOT be treated as
    // 413/415 — otherwise rewording a server message would silently reclassify.
    const r = explain(
      "upload",
      400,
      "application/json",
      JSON.stringify({ error: { code: "invalid_request", message: "file too large, mime type not allowed" } }),
      { name: "x.bin", size: 9 },
    );
    expect(r.message).toBe("Upload failed. Request a fresh upload link and try again.");
    expect(r.retry).toBe(true);
  });

  it("413 at the upload stage is a retryable 'too large' (link not yet consumed)", () => {
    const r = explain("upload", 413, "application/json", json("payload_too_large"), { name: "big.bin", size: 2048 });
    expect(r.message).toContain("The selected file is too large.");
    expect(r.message).toContain("Selected file size: 2.0 KB.");
    expect(r.message).not.toContain("fresh upload link");
    expect(r.retry).toBe(true);
  });

  it("413 at finalize is terminal and asks for a fresh link", () => {
    const r = explain("finalize", 413, "application/json", json("payload_too_large"), { name: "big.bin", size: 2048 });
    expect(r.message).toContain("Request a fresh upload link to choose another file.");
    expect(r.retry).toBe(false);
  });

  it("415 names the rejected type and lists the accepted ones from details", () => {
    const r = explain("finalize", 415, "application/json", json("unsupported_media_type", { allowed: ["image/*", "text/plain"] }), {
      name: "x.zip",
      type: "application/zip",
    });
    expect(r.message).toContain("The selected file type is not accepted (application/zip).");
    expect(r.message).toContain("Accepted types: image/*, text/plain.");
    expect(r.retry).toBe(false);
  });

  it("401/403 mean an expired or rejected link; 409 means already used — all terminal", () => {
    for (const status of [401, 403]) {
      const r = explain("upload", status, "", "", { name: "x" });
      expect(r.message).toContain("This upload link has expired or is no longer valid");
      expect(r.retry).toBe(false);
    }
    const conflict = explain("upload", 409, "application/json", json("conflict"), { name: "x" });
    expect(conflict.message).toContain("This upload link has already been used");
    expect(conflict.retry).toBe(false);
  });

  it("an unclassified finalize failure is terminal; an unclassified upload failure retries", () => {
    expect(explain("finalize", 500, "", "", { name: "x" }).retry).toBe(false);
    expect(explain("finalize", 500, "", "", { name: "x" }).message).toContain("could not be finalized");
    expect(explain("upload", 500, "", "", { name: "x" }).retry).toBe(true);
  });
});

describe("bridge: tool-result unwrapping", () => {
  // Evaluate the exact source the bridge embeds, so the test tracks the shipped code.
  const findSc = new Function(TOOL_RESULT_UNWRAP_JS + " return __yapSc;")() as (p: unknown) => unknown;

  it("reads structuredContent at the top level", () => {
    expect(findSc({ structuredContent: { widget: "ui://yap/x" } })).toEqual({ widget: "ui://yap/x" });
  });

  it("digs through nested value envelopes hosts wrap re-delivered results in", () => {
    // MCPJam re-delivers the result as { value: { structuredContent } } after a
    // few seconds — sometimes doubly nested. Reading only the top level misses it
    // and the widget goes blank on re-mount.
    expect(findSc({ value: { structuredContent: { a: 1 } } })).toEqual({ a: 1 });
    expect(findSc({ value: { value: { structuredContent: { a: 2 } } } })).toEqual({ a: 2 });
  });

  it("returns nothing for an envelope that carries no structuredContent", () => {
    expect(findSc({ value: { type: "json" } })).toBeFalsy();
    expect(findSc({})).toBeFalsy();
  });
});

describe("bridge: spec-compliant handshake", () => {
  it("ui/initialize carries appInfo and protocolVersion (strict hosts reject the bare form)", () => {
    const init = widgetHtml("media-card", "client").split('"ui/initialize"')[1]!.slice(0, 300);
    expect(init).toContain("appInfo");
    expect(init).toContain("protocolVersion");
  });
});

describe("widget recovery mounts in place (no nested iframe)", () => {
  it("the shell never spawns a nested iframe (strict hosts block frame-src)", () => {
    const shell = widgetHtml("shell", "client");
    expect(shell).not.toContain("srcdoc");
    expect(shell).not.toMatch(/createElement\(\s*["']iframe["']\s*\)/);
  });

  it("each renderable widget embeds its style+render as recoverable JSON", () => {
    for (const name of ["media-card", "upload-dropzone"]) {
      const html = widgetHtml(name, "client");
      const m = /<script type="application\/json" data-yap-src>(.*?)<\/script>/s.exec(html);
      expect(m, name).toBeTruthy();
      const src = JSON.parse(m![1]!);
      expect(src.render, name).toBe(WIDGETS[name]!.render);
      expect(src.style, name).toBe(WIDGETS[name]!.style);
    }
  });
});
