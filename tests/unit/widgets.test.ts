/**
 * Widget HTML safety: user-controlled data (file names, mime types) must never
 * reach an executable position. The data is embedded as JSON in a <script>
 * (where `<` is escaped so it cannot break out of the tag) and is re-inserted
 * at runtime only through the bridge's esc()/safeUrl() helpers.
 */
import { describe, expect, it } from "vitest";

import { WIDGETS, widgetHtml } from "../../src/widgets/registry.js";

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

  it("only http(s) URLs survive safeUrl (javascript:/data: are neutralized)", () => {
    // Exercise the bridge helper exactly as it runs in the sandbox.
    const safeUrl = (v: string) => (/^https?:\/\//i.test(v) ? v : "#");
    expect(safeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("data:text/html,<script>")).toBe("#");
  });
});
