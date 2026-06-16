/**
 * The widget registry: every widget is a ui:// resource, self-contained by
 * construction — one chunk of HTML with styling and behavior inlined, no
 * external libraries, fonts, or links. The same HTML renders through all
 * three paths: result-level delivery via call, the show_widget shell, and
 * origin-hosted pages at signed URLs.
 *
 * The host bridge abstracts the render target: in-client, data arrives via
 * postMessage JSON-RPC after the iframe loads and events flow back the same
 * way; origin-hosted, data is embedded at serve time (window.__YAP_DATA__)
 * and there is no event channel — effects land directly in the system and
 * the agent observes the state change.
 */

export const UI_SCHEME_PREFIX = "ui://yap/";

export interface WidgetDef {
  name: string;
  uri: string;
  description: string;
  /** Body renderer + styles; the bridge is shared. */
  style: string;
  render: string;
  /** Origin pages are disabled for host-dependent widgets (the shell). */
  originHostable: boolean;
}

/** Shared bridge, inlined into every widget. */
const BRIDGE_JS = `
  var MODE = document.documentElement.getAttribute("data-yap-mode") || "client";
  var pending = {};
  var reqId = 1;
  function send(msg) { try { parent.postMessage(msg, "*"); } catch (e) {} }
  function announceHeight() {
    send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } });
  }
  function emit(event, params) {
    if (MODE === "client") send({ jsonrpc: "2.0", method: "ui/event", params: Object.assign({ event: event }, params || {}) });
  }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = reqId++;
      pending[id] = { resolve: resolve, reject: reject };
      send({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && pending[m.id]) {
      var p = pending[m.id];
      delete pending[m.id];
      if (m.error) p.reject(m.error); else p.resolve(m.result);
      return;
    }
    // Internal channel: the shell pushes a nested widget's data this way.
    if (m.method === "ui/render-data" || m.method === "ui/notifications/render-data") {
      var d = (m.params && m.params.data) || m.params || {};
      window.__yapOnData && window.__yapOnData(d);
      return;
    }
    // MCP Apps channel: the host delivers the tool result; our data rides in
    // structuredContent (see show_widget). Some hosts re-deliver tool-result on
    // reconnect/refresh with no structuredContent — ignore those so an empty
    // update can't clobber an already-rendered view.
    if (m.method === "ui/notifications/tool-result") {
      var sc = m.params && m.params.structuredContent;
      if (sc && typeof sc === "object" && Object.keys(sc).length > 0) {
        window.__yapOnData && window.__yapOnData(sc);
      }
      return;
    }
    // tool-input carries the call's arguments. When a host re-mounts the iframe
    // it replays these even if it drops our structuredContent — so they're the
    // recovery path: {widget, params} with no html, which the shell resolves
    // via resources/read.
    if (m.method === "ui/notifications/tool-input") {
      var args = m.params && m.params.arguments;
      if (args && typeof args === "object" && args.widget) {
        // The replayed arg is whatever the caller passed (possibly a bare name);
        // normalize to the registered ui:// uri so resources/read can resolve it.
        var w = String(args.widget);
        if (w.indexOf("://") === -1) w = "${UI_SCHEME_PREFIX}" + w;
        window.__yapOnData && window.__yapOnData({ widget: w, params: args.params });
      }
      return;
    }
  });
  function onData(cb) {
    window.__yapOnData = function (d) { cb(d); requestAnimationFrame(announceHeight); };
    // Origin-hosted: data is baked into the page; no host channel at all.
    if (window.__YAP_DATA__) { window.__yapOnData(window.__YAP_DATA__); return; }
    // MCP Apps handshake (ui/initialize -> initialized). A non-MCP-Apps parent
    // (e.g. the shell, when this widget is nested) simply won't answer; we also
    // emit ui/ready so the shell can push data over the internal channel.
    request("ui/initialize", { appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } })
      .then(function () { send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }); })
      .catch(function () {});
    send({ jsonrpc: "2.0", method: "ui/ready" });
  }
  // HTML-escape for text and double-quoted-attribute contexts. Widget data
  // (file names, mime types) is user-controlled and must never be trusted in
  // an innerHTML sink.
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  // Allow only http(s) URLs into href/src; reject javascript:, data:, etc.
  function safeUrl(v) {
    var s = String(v == null ? "" : v);
    return /^https?:\\/\\//i.test(s) ? esc(s) : "#";
  }
  // Mirror the bridge onto window so a widget the shell mounts in-place (its
  // render injected as a top-level <script>, not wrapped in this IIFE) can still
  // resolve onData/esc/safeUrl/emit/announceHeight by their bare names.
  window.onData = onData; window.esc = esc; window.safeUrl = safeUrl;
  window.emit = emit; window.announceHeight = announceHeight;
  window.request = request; window.send = send;
`;

const BASE_STYLE = `
  :root {
    color-scheme: light dark;
    /* Inherit the host's surface and theme tokens where provided; every token
       carries a light-dark() fallback so the widget themes correctly on hosts
       that pass nothing. Background defaults to transparent so we sit on the
       host's own surface instead of painting an opaque slab. */
    --yap-font: var(--font-sans, system-ui, -apple-system, sans-serif);
    --yap-fg: var(--color-text-primary, light-dark(#16161d, #ededf2));
    --yap-fg-muted: var(--color-text-secondary, light-dark(#5b5b66, #9a9aa6));
    --yap-bg: var(--color-background-primary, transparent);
    --yap-surface: var(--color-background-secondary, light-dark(rgba(22,22,29,.05), rgba(255,255,255,.07)));
    --yap-border: var(--color-border-primary, light-dark(rgba(22,22,29,.18), rgba(255,255,255,.2)));
    --yap-danger: var(--color-text-danger, light-dark(#c0392b, #ff6b5e));
  }
  * { box-sizing: border-box; }
  /* The widget renders inside the host's own container; we draw no card chrome
     of our own — the host owns the surface and border. The body is that
     container, and its padding is the single source of content inset. */
  body { margin: 0; font: 14px/1.45 var(--yap-font); color: var(--yap-fg); background: var(--yap-bg); padding: 18px; }
  .card { max-width: 560px; }
  .muted { color: var(--yap-fg-muted); font-size: 12px; }
  .err { color: var(--yap-danger); }
  button { font: inherit; color: inherit; padding: 6px 14px; border-radius: var(--border-radius-small, 8px);
           border: 1px solid var(--yap-border); background: var(--yap-surface); cursor: pointer; }
`;

export const WIDGETS: Record<string, WidgetDef> = {
  shell: {
    name: "shell",
    uri: `${UI_SCHEME_PREFIX}shell`,
    description:
      "Generic widget shell: renders any registered ui:// widget in its own document with the supplied params. The statically-declared template for show_widget.",
    originHostable: false,
    // Kept only for the rare recovery iframe (see below); the in-place widget
    // sits directly in the shell body and inherits BASE_STYLE's inset.
    style: ".shellframe { border: 0; width: 100%; }",
    render: `
      var root = document.getElementById("root");
      var rendered = false;
      var fallbackTimer = null;
      function fail(msg) { if (!rendered) root.innerHTML = '<div class="card err">shell: ' + msg + '</div>'; }
      onData(function (d) {
        if (!d || !d.widget) { fail("no widget named"); return; }
        // A spurious re-deliver must not clobber a widget we already mounted.
        if (rendered) return;
        // Primary path: show_widget inlines the chosen widget's style + render in
        // structuredContent. Mount it in THIS document — no nested iframe, which a
        // strict host (Claude Desktop, Mistral Vibe) won't let a widget frame
        // spawn (frame-src), leaving the old nesting shell blank.
        if (d.render) {
          if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
          rendered = true;
          if (d.style) { var st = document.createElement("style"); st.textContent = d.style; document.head.appendChild(st); }
          // Re-point the data channel: the widget's onData(cb) must receive its
          // own params, not this shell envelope.
          window.onData = function (cb) { cb(d.params || {}); requestAnimationFrame(announceHeight); };
          // Inline script — runs under the same CSP the shell document already
          // satisfies (no nested frame, no eval).
          var s = document.createElement("script");
          s.textContent = d.render;
          document.body.appendChild(s);
          return;
        }
        // Recovery path: a host re-mounted us and replayed only the tool-input
        // {widget, params} with no structuredContent, so we lack the source.
        // Give the richer tool-result a beat to arrive before fetching the
        // widget's document through the host and framing it (best effort; a host
        // that suppresses structuredContent on re-mount is the exception).
        if (fallbackTimer) return;
        var uri = d.widget.indexOf("://") === -1 ? "${UI_SCHEME_PREFIX}" + d.widget : d.widget;
        fallbackTimer = setTimeout(function () {
          fallbackTimer = null;
          if (rendered) return;
          request("resources/read", { uri: uri })
            .then(function (r) {
              var html = r && r.contents && r.contents[0] && r.contents[0].text;
              if (!html || rendered) { if (!html) fail("empty widget"); return; }
              rendered = true;
              var f = document.createElement("iframe");
              f.className = "shellframe";
              f.setAttribute("sandbox", "allow-scripts");
              f.srcdoc = html;
              f.onload = function () {
                f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/render-data", params: { data: d.params || {} } }, "*");
              };
              window.addEventListener("message", function (e) {
                if (e.source === f.contentWindow && e.data && e.data.method === "ui/notifications/size-changed" && e.data.params) {
                  f.style.height = e.data.params.height + "px";
                  requestAnimationFrame(announceHeight);
                }
              });
              root.innerHTML = "";
              root.appendChild(f);
            })
            .catch(function (err) { fail("could not load widget (" + (err && err.message || err) + ")"); });
        }, 300);
      });
    `,
  },

  "upload-dropzone": {
    name: "upload-dropzone",
    uri: `${UI_SCHEME_PREFIX}upload-dropzone`,
    description:
      "File-upload dropzone: lets a human pick or drop a file, streams it to the signed upload link, and finalizes the upload. Data: { file_id, upload_url, complete_url, name? }.",
    originHostable: true,
    style: `
      .drop { border: 2px dashed rgba(128,128,128,.5); border-radius: 10px; padding: 28px; text-align: center; max-width: 560px; }
      .drop.over { border-color: #4a90d9; background: rgba(74,144,217,.08); }
      .done { color: #2e7d32; }
    `,
    render: `
      onData(function (d) {
        var root = document.getElementById("root");
        root.innerHTML = '<div class="drop" id="zone"><p><strong>Drop a file here</strong> or</p>' +
          '<p><button id="pick">Choose file</button></p>' +
          '<input id="file" type="file" style="display:none">' +
          '<p class="muted" id="status">Waiting for a file\\u2026</p></div>';
        var zone = document.getElementById("zone");
        var input = document.getElementById("file");
        var status = document.getElementById("status");
        function setStatus(text, cls) { status.textContent = text; status.className = "muted " + (cls || ""); requestAnimationFrame(announceHeight); }
        function upload(file) {
          setStatus("Uploading " + file.name + "\\u2026");
          fetch(d.upload_url, { method: "PUT", body: file })
            .then(function (r) { if (!r.ok) throw new Error("upload failed (" + r.status + ")"); })
            .then(function () {
              return fetch(d.complete_url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: file.name, mime_type: file.type || "application/octet-stream" }),
              });
            })
            .then(function (r) { if (!r.ok) throw new Error("finalize failed (" + r.status + ")"); return r.json(); })
            .then(function (f) {
              setStatus("Uploaded " + f.name + " (" + f.size + " bytes)", "done");
              emit("upload-complete", { file_id: d.file_id, name: f.name, size: f.size });
            })
            .catch(function (err) { setStatus(String(err && err.message || err), "err"); });
        }
        document.getElementById("pick").addEventListener("click", function () { input.click(); });
        input.addEventListener("change", function () { if (input.files[0]) upload(input.files[0]); });
        ["dragover", "dragenter"].forEach(function (ev) {
          zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("over"); });
        });
        ["dragleave", "drop"].forEach(function (ev) {
          zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove("over"); });
        });
        zone.addEventListener("drop", function (e) {
          if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
        });
      });
    `,
  },

  "media-card": {
    name: "media-card",
    uri: `${UI_SCHEME_PREFIX}media-card`,
    description:
      "Media card for show_file: images, audio, and video play inline; anything else gets a clean file card. Every kind offers a plain-text download link. Data: { kind, url, name?, mime_type?, size? }.",
    originHostable: true,
    style: `
      img { max-width: 100%; border-radius: 8px; display: block; }
      audio { width: 100%; }
      /* Fit the real video's content height once metadata loads (natural ratio);
         fall back to 16:9 only for the pre-load placeholder, so the box doesn't
         start as a squat default and jump. */
      video { width: 100%; aspect-ratio: auto 16 / 9; border-radius: 8px; display: block; }
      .filerow { display: flex; align-items: center; gap: 12px; }
      .fileicon { font-size: 28px; }
      .dl-line { margin: 12px 0 0; }
      a.dl { color: inherit; font-size: 13px; text-decoration: underline; text-underline-offset: 2px; }
    `,
    render: `
      onData(function (d) {
        var root = document.getElementById("root");
        var name = esc(d.name || "file");
        var url = safeUrl(d.url);
        var size = Number(d.size) || 0;
        var sizeNote = size ? '<span class="muted"> \\u00b7 ' + size + " bytes</span>" : "";
        var inner;
        if (d.kind === "image") inner = '<img src="' + url + '" alt="' + name + '">';
        else if (d.kind === "audio") inner = '<audio controls src="' + url + '"></audio>';
        else if (d.kind === "video") inner = '<video controls src="' + url + '"></video>';
        else inner = '<div class="filerow"><span class="fileicon">\\ud83d\\udcc4</span><div><div>' + name + sizeNote +
          '</div><div class="muted">' + esc(d.mime_type || "") + '</div></div></div>';
        // A plain-text download link for every file type, sitting where the
        // expiry note used to. Omitted only when the URL isn't a usable
        // http(s) link (safeUrl collapses those to "#").
        var dl = url !== "#" ? '<p class="dl-line"><a class="dl" href="' + url + '" download>Download</a></p>' : "";
        root.innerHTML = '<div class="card">' + inner + dl + "</div>";
        var media = root.querySelector("img,video,audio");
        if (media) media.addEventListener(media.tagName === "IMG" ? "load" : "loadedmetadata", announceHeight);
      });
    `,
  },
};

function escapeForInlineJson(json: string): string {
  return json.replace(/</g, "\\u003c");
}

/** Client-mode HTML is identical for a given widget (no per-call data), so the
 *  full template assembly is built once and reused for resources/read and
 *  show_widget. */
const clientHtmlCache = new Map<string, string>();

/**
 * Builds the complete, self-contained widget HTML. In client mode the page
 * waits for ui/render-data over postMessage; in origin mode the data is
 * embedded at serve time and there is no event channel.
 */
export function widgetHtml(name: string, mode: "client" | "origin", data?: unknown): string {
  const cached = mode === "client" ? clientHtmlCache.get(name) : undefined;
  if (cached) return cached;
  const def = WIDGETS[name];
  if (!def) throw new Error(`unknown widget ${name}`);
  const dataScript =
    mode === "origin" ? `<script>window.__YAP_DATA__ = ${escapeForInlineJson(JSON.stringify(data ?? {}))};</script>` : "";
  const html = `<!doctype html>
<html data-yap-mode="${mode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>yap ${def.name}</title>
<style>${BASE_STYLE}${def.style}</style>
</head>
<body>
<div id="root"></div>
${dataScript}
<script>
(function () {
${BRIDGE_JS}
${def.render}
})();
</script>
</body>
</html>`;
  if (mode === "client") clientHtmlCache.set(name, html);
  return html;
}
