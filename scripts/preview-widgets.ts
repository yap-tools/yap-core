/**
 * Local widget design harness — NOT part of the server.
 *
 * Renders every registered widget through the real `widgetHtml(..., "origin")`
 * path (data baked into the page, no host channel) into a single gallery, so
 * you can iterate on widget styling in a plain browser. Run it under tsx watch
 * and editing src/widgets/registry.ts restarts the server — just refresh.
 *
 *   npm run preview:widgets   →   http://127.0.0.1:4505
 *
 * media-card's safeUrl() only admits http(s) URLs, so sample media is served
 * from this same origin (/assets/*). Audio/video players render their chrome
 * even where the bytes are a stub — enough to judge layout.
 */
import { createServer } from "node:http";

import { widgetHtml, WIDGETS } from "../src/widgets/registry.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 4505;
const base = `http://${HOST}:${PORT}`;

/** A self-contained SVG so media-card's image kind has something to show offline. */
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#4a90d9"/><stop offset="1" stop-color="#8e44ad"/>
  </linearGradient></defs>
  <rect width="480" height="300" fill="url(#g)"/>
  <text x="240" y="158" font-family="system-ui, sans-serif" font-size="22" fill="#fff"
        text-anchor="middle">sample image</text>
</svg>`;

const img = `${base}/assets/placeholder.svg`;
const audio = `${base}/assets/sample.mp3`;
// A real public 16:9 test clip (Big Buck Bunny, 640×360, ~1MB) so the video
// card actually plays; needs network. The rest of the assets stay local stubs.
const video = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";
const blob = `${base}/assets/report.pdf`;

interface Card {
  label: string;
  widget: keyof typeof WIDGETS;
  data: unknown;
}

const imageData = { kind: "image", name: "sunset.jpg", mime_type: "image/jpeg", size: 240133, url: img, expires_in: 3600 };

const CARDS: Card[] = [
  { label: "media-card · image", widget: "media-card", data: imageData },
  { label: "media-card · audio", widget: "media-card", data: { kind: "audio", name: "voice-memo.mp3", mime_type: "audio/mpeg", size: 1820400, url: audio } },
  { label: "media-card · video", widget: "media-card", data: { kind: "video", name: "big-buck-bunny.mp4", mime_type: "video/mp4", size: 991017, url: video } },
  { label: "media-card · file", widget: "media-card", data: { kind: "file", name: "quarterly-report.pdf", mime_type: "application/pdf", size: 482113, url: blob, expires_in: 900 } },
  { label: "upload-dropzone", widget: "upload-dropzone", data: { file_id: "file_demo", upload_url: `${base}/assets/sink`, complete_url: `${base}/assets/sink` } },
  {
    label: "shell → media-card",
    widget: "shell",
    data: { widget: WIDGETS["media-card"].uri, html: widgetHtml("media-card", "origin", imageData), params: imageData },
  },
];

/** Gallery page: each card is an iframe that auto-sizes off the widget's own
 *  ui/notifications/size-changed message — the same channel a real host uses. */
function gallery(): string {
  const cells = CARDS.map(
    (c, i) => `
    <figure class="cell">
      <figcaption>${c.label}</figcaption>
      <iframe data-i="${i}" src="/w/${i}" title="${c.label}"></iframe>
    </figure>`,
  ).join("");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>yap widget preview</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, sans-serif; }
  header { display: flex; align-items: center; gap: 16px; padding: 14px 20px; border-bottom: 1px solid rgba(128,128,128,.3); position: sticky; top: 0; backdrop-filter: blur(8px); background: color-mix(in srgb, Canvas 80%, transparent); }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .hint { font-size: 12px; opacity: .6; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 22px; padding: 22px; }
  .cell { margin: 0; border: 1px solid rgba(128,128,128,.28); border-radius: 12px; overflow: hidden; background: color-mix(in srgb, Canvas 96%, CanvasText); }
  figcaption { font-size: 12px; font-weight: 600; letter-spacing: .02em; padding: 9px 14px; border-bottom: 1px solid rgba(128,128,128,.22); opacity: .8; }
  iframe { border: 0; width: 100%; display: block; }
  /* Theme switcher: reflects the host theme baked into each widget iframe. */
  .seg { display: inline-flex; margin-left: auto; border: 1px solid rgba(128,128,128,.4); border-radius: 8px; overflow: hidden; }
  .seg button { font: inherit; font-size: 12px; padding: 5px 11px; border: 0; border-left: 1px solid rgba(128,128,128,.3); background: transparent; color: inherit; cursor: pointer; }
  .seg button:first-child { border-left: 0; }
  .seg button.on { background: #4a90d9; color: #fff; }
  /* Canvas reacts to the chosen theme so transparent widgets sit on a matching
     surface; "host" uses the injected token background so widgets blend. */
  html[data-theme="dark"], html[data-theme="host"] { color-scheme: dark; }
  html[data-theme="dark"] body { background: #0d0e10; }
  html[data-theme="dark"] .cell { background: #15171b; border-color: rgba(255,255,255,.12); }
  html[data-theme="host"] body { background: #0c0d10; }
  html[data-theme="host"] .cell { background: #16171c; border-color: rgba(255,255,255,.1); }
</style>
</head>
<body>
<header>
  <h1>yap widgets</h1>
  <span class="hint">origin-rendered · auto-sized via ui/notifications/size-changed</span>
  <div class="seg" role="group" aria-label="Theme">
    <button data-theme-set="light">Light</button>
    <button data-theme-set="dark">Dark</button>
    <button data-theme-set="host">Dark · host tokens</button>
  </div>
</header>
<main>${cells}</main>
<script>
  var frames = document.querySelectorAll("iframe");

  // Each widget posts its content height to us (its parent), exactly as it would
  // to an MCP host; resize the matching frame to fit.
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.method !== "ui/notifications/size-changed" || !m.params) return;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === e.source) { frames[i].style.height = (m.params.height + 4) + "px"; break; }
    }
  });

  // Theme switch: reload each widget with the chosen ?theme so the host theme is
  // baked into the document (the faithful path, and the only one that reaches
  // the shell's sandboxed nested frame).
  var seg = document.querySelectorAll(".seg button");
  function setTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    for (var i = 0; i < frames.length; i++) frames[i].src = "/w/" + frames[i].getAttribute("data-i") + "?theme=" + t;
    for (var j = 0; j < seg.length; j++) seg[j].classList.toggle("on", seg[j].getAttribute("data-theme-set") === t);
  }
  for (var k = 0; k < seg.length; k++) {
    seg[k].addEventListener("click", function () { setTheme(this.getAttribute("data-theme-set")); });
  }
  setTheme("light");
</script>
</body>
</html>`;
}

function send(res: import("node:http").ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

/** A sample dark host token set — what a real host injects via HostContext. */
const HOST_TOKEN_CSS =
  "--color-background-primary:#16171c;--color-background-secondary:#23252b;" +
  "--color-text-primary:#e7e8ec;--color-text-secondary:#9aa0a6;" +
  "--color-border-primary:rgba(255,255,255,.16);--color-text-danger:#ff6b5e;";

/**
 * Inject a theme override the way a host would: a late <style> that pins
 * `color-scheme` (which drives the widgets' light-dark() fallbacks) and, for
 * "host", also supplies a dark host token set so the var()-token path is
 * exercised, not just the fallbacks. Baking it into the document (rather than
 * forcing it from the parent) is also what lets the theme reach the shell's
 * sandboxed, opaque-origin nested iframe.
 */
function themeStyleTag(theme: string): string {
  if (theme === "dark") return "<style>:root{color-scheme:dark}</style>";
  if (theme === "host") return `<style>:root{color-scheme:dark;${HOST_TOKEN_CSS}}</style>`;
  return "<style>:root{color-scheme:light}</style>";
}

function themed(html: string, theme: string): string {
  return html.replace("</head>", `${themeStyleTag(theme)}</head>`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", base);
  const path = url.pathname;

  if (path === "/" || path === "") return send(res, 200, "text/html; charset=utf-8", gallery());

  const widgetMatch = /^\/w\/(\d+)$/.exec(path);
  if (widgetMatch) {
    const card = CARDS[Number(widgetMatch[1])];
    if (!card) return send(res, 404, "text/plain", "no such card");
    const theme = url.searchParams.get("theme") ?? "light";
    // The shell mounts its nested widget in a sandboxed (opaque-origin) iframe
    // that nothing outside can reach into, so the nested HTML must be themed
    // here before it's handed to the shell.
    if (card.widget === "shell") {
      const nested = themed(widgetHtml("media-card", "origin", imageData), theme);
      const shellData = { widget: WIDGETS["media-card"].uri, html: nested, params: imageData };
      return send(res, 200, "text/html; charset=utf-8", themed(widgetHtml("shell", "origin", shellData), theme));
    }
    return send(res, 200, "text/html; charset=utf-8", themed(widgetHtml(card.widget, "origin", card.data), theme));
  }

  if (path === "/assets/placeholder.svg") return send(res, 200, "image/svg+xml", PLACEHOLDER_SVG);
  // Stub the remaining sample assets: audio/video render their player chrome
  // regardless, and the dropzone's sink just needs a 2xx to look successful.
  if (path.startsWith("/assets/")) return send(res, 200, "application/octet-stream", "");

  return send(res, 404, "text/plain", "not found");
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`\n  yap widget preview → ${base}\n  editing src/widgets/registry.ts under \`tsx watch\` restarts this server.\n`);
});
