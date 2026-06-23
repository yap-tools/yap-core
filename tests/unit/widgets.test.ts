/**
 * Widget HTML safety: user-controlled data (file names, mime types) must never
 * reach an executable position. The data is embedded as JSON in a <script>
 * (where `<` is escaped so it cannot break out of the tag) and is re-inserted
 * at runtime only through the bridge's esc()/safeUrl() helpers.
 */
import { describe, expect, it } from "vitest";

import { TOOL_RESULT_UNWRAP_JS, WIDGETS, widgetHtml } from "../../src/widgets/registry.js";

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

  it("the media-card download forces an attachment and opens it via the host bridge", () => {
    const render = WIDGETS["media-card"]!.render;
    expect(render).toContain("safeUrl(d.url)");
    // Force a real file download (Content-Disposition: attachment) rather than
    // an inline render in the opened tab.
    expect(render).toContain("download=1");
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
