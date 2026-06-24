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

/** Dig the tool result's structuredContent out of a (possibly nested) params
 * envelope. Hosts re-deliver a result wrapped in { value: { … } } — sometimes
 * several levels deep (MCPJam does this seconds after the first render); reading
 * only the top level misses it and the widget blanks on re-mount. Exported as
 * source so the bridge and its unit test share one definition. */
export const TOOL_RESULT_UNWRAP_JS =
  `function __yapSc(params){var p=params,sc=p&&p.structuredContent,g=0;` +
  `while(!sc&&p&&typeof p.value==="object"&&p.value!==null&&g++<5){p=p.value;sc=p.structuredContent;}return sc;}`;

/** Shared bridge, inlined into every widget. */
const BRIDGE_JS = `
  var MODE = document.documentElement.getAttribute("data-yap-mode") || "client";
  var pending = {};
  var reqId = 1;
  ${TOOL_RESULT_UNWRAP_JS}
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
    // structuredContent (see show_widget). Some hosts wrap a re-delivered result
    // in one or more { value: … } envelopes — dig through them. A re-deliver with
    // no structuredContent is ignored so an empty update can't clobber a rendered
    // view (the shell's own render guard also protects against that).
    if (m.method === "ui/notifications/tool-result") {
      var sc = __yapSc(m.params);
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
    // appInfo + protocolVersion are required by spec-strict hosts: MCPJam logs
    // -32603 (and masks it with its own shim) and Claude leaves the widget blank
    // when they're absent. Bare appCapabilities is not enough.
    request("ui/initialize", {
      appInfo: { name: "yap", version: "1" },
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      protocolVersion: "2026-01-26",
    })
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
    // No chrome of its own: the mounted widget sits directly in the shell body
    // and inherits BASE_STYLE's inset.
    style: "",
    render: `
      var root = document.getElementById("root");
      var rendered = false;
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
        // {widget, params} with no inline render. Read the widget's document
        // through the host, pull its embedded {style, render} (data-yap-src), and
        // mount it IN THIS document — never a nested iframe, which strict hosts
        // (Claude: frame-src 'self' …; MCPJam strict) refuse to spawn, the old blank.
        var uri = d.widget.indexOf("://") === -1 ? "${UI_SCHEME_PREFIX}" + d.widget : d.widget;
        request("resources/read", { uri: uri })
          .then(function (r) {
            if (rendered) return;
            var html = r && r.contents && r.contents[0] && r.contents[0].text;
            var doc = html && new DOMParser().parseFromString(html, "text/html");
            var el = doc && doc.querySelector("[data-yap-src]");
            var src = el ? JSON.parse(el.textContent) : null;
            if (!src || !src.render) { fail("empty widget"); return; }
            rendered = true;
            if (src.style) { var st = document.createElement("style"); st.textContent = src.style; document.head.appendChild(st); }
            window.onData = function (cb) { cb(d.params || {}); requestAnimationFrame(announceHeight); };
            var s = document.createElement("script");
            s.textContent = src.render;
            document.body.appendChild(s);
          })
          .catch(function (err) { fail("could not load widget (" + (err && err.message || err) + ")"); });
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
      .progress { display: none; margin: 14px auto 0; max-width: 360px; text-align: left; }
      .progress.visible { display: block; }
      .track { overflow: hidden; height: 8px; border-radius: 999px; background: var(--yap-surface); border: 1px solid var(--yap-border); }
      .bar { width: 0%; height: 100%; background: #4a90d9; transition: width .18s ease; }
      .progress.indeterminate .bar { width: 28%; animation: yap-upload-pulse 1.1s ease-in-out infinite alternate; }
      .phase { display: block; margin-top: 6px; font-size: 12px; color: var(--yap-fg-muted); }
      .done { color: #2e7d32; }
      .err { color: var(--yap-danger); }
      button:disabled { opacity: .6; cursor: default; }
      @keyframes yap-upload-pulse { from { transform: translateX(0); } to { transform: translateX(260%); } }
    `,
    render: `
      onData(function (d) {
        var root = document.getElementById("root");
        root.innerHTML = '<div class="drop" id="zone"><p><strong>Drop a file here</strong> or</p>' +
          '<p><button id="pick">Choose file</button></p>' +
          '<input id="file" type="file" style="display:none">' +
          '<p class="muted" id="status">Waiting for a file\\u2026</p>' +
          '<div class="progress" id="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
          '<div class="track"><div class="bar" id="bar"></div></div><span class="phase" id="phase"></span></div></div>';
        var zone = document.getElementById("zone");
        var input = document.getElementById("file");
        var status = document.getElementById("status");
        var pick = document.getElementById("pick");
        var progress = document.getElementById("progress");
        var bar = document.getElementById("bar");
        var phase = document.getElementById("phase");
        var busy = false;
        var locked = false;
        function setStatus(text, cls) { status.textContent = text; status.className = "muted " + (cls || ""); requestAnimationFrame(announceHeight); }
        function setControls(enabled) { pick.disabled = !enabled; }
        function setProgress(percent, text, indeterminate) {
          var pct = Math.max(0, Math.min(100, Number(percent) || 0));
          progress.className = "progress visible" + (indeterminate ? " indeterminate" : "");
          progress.setAttribute("aria-valuenow", String(Math.round(pct)));
          bar.style.width = pct + "%";
          phase.textContent = text || "";
          requestAnimationFrame(announceHeight);
        }
        function resetProgress() {
          progress.className = "progress";
          progress.setAttribute("aria-valuenow", "0");
          bar.style.width = "0%";
          phase.textContent = "";
        }
        function formatBytes(size) {
          if (!size && size !== 0) return "";
          var units = ["bytes", "KB", "MB", "GB"];
          var n = Number(size);
          var i = 0;
          while (n >= 1024 && i < units.length - 1) { n = n / 1024; i++; }
          return (i === 0 ? String(n) : n.toFixed(n < 10 ? 1 : 0)) + " " + units[i];
        }
        function textFromXml(text) {
          return String(text || "").replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").trim();
        }
        function parseError(contentType, bodyText) {
          var body = String(bodyText || "");
          var out = { message: "", details: null };
          if ((contentType || "").indexOf("json") !== -1 || /^[\\s\\r\\n]*[\\{\\[]/.test(body)) {
            try {
              var parsed = JSON.parse(body);
              var err = parsed && parsed.error ? parsed.error : parsed;
              out.message = String((err && err.message) || "");
              out.details = err && err.details ? err.details : null;
              return out;
            } catch (_e) {}
          }
          out.message = (contentType || "").indexOf("xml") !== -1 ? textFromXml(body) : body.replace(/\\s+/g, " ").trim();
          return out;
        }
        function fileTypeLabel(file) {
          if (file.type) return file.type;
          var m = /\\.([^.]+)$/.exec(file.name || "");
          return m ? "." + m[1] : "this file type";
        }
        function allowedLabel(details) {
          var allowed = details && details.allowed;
          return Array.isArray(allowed) && allowed.length ? " Accepted types: " + allowed.join(", ") + "." : "";
        }
        function explainFailure(stage, statusCode, contentType, bodyText, file) {
          var parsed = parseError(contentType, bodyText);
          var msg = parsed.message || "";
          var low = msg.toLowerCase();
          var prefix = stage === "finalize" ? "Finalizing failed." : "Upload failed.";
          if (statusCode === 401 || /invalid|expired|token/.test(low)) {
            return { message: "This upload link has expired or is no longer valid. Request a fresh upload link and try again.", retry: false };
          }
          if (statusCode === 409 || /already|consumed|finalized|conflict/.test(low)) {
            return { message: "This upload link has already been used. Request a fresh upload link and try again.", retry: false };
          }
          if (statusCode === 413 || /maximum size|exceeds|too large|file size|payload too large/.test(low)) {
            var size = file && file.size ? " Selected file size: " + formatBytes(file.size) + "." : "";
            return { message: "The selected file is too large." + size + (msg ? " " + msg : ""), retry: true };
          }
          if (statusCode === 415 || /mime type|file type|content type|unsupported media type|not allowed/.test(low)) {
            return { message: "The selected file type is not accepted (" + fileTypeLabel(file) + ")." + allowedLabel(parsed.details), retry: true };
          }
          if (stage === "finalize") {
            return { message: prefix + " The bytes uploaded, but the file could not be finalized; request a fresh upload link and try again.", retry: false };
          }
          return { message: prefix + " Request a fresh upload link and try again.", retry: true };
        }
        function readJsonOrText(response) {
          var contentType = response.headers.get("content-type") || "";
          return response.text().then(function (text) {
            var data = null;
            if (contentType.indexOf("json") !== -1 || /^[\\s\\r\\n]*[\\{\\[]/.test(text)) {
              try { data = JSON.parse(text); } catch (_e) {}
            }
            return { ok: response.ok, status: response.status, contentType: contentType, text: text, data: data };
          });
        }
        function putFile(file) {
          return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open("PUT", d.upload_url);
            xhr.upload.onprogress = function (evt) {
              if (evt.lengthComputable) {
                var pct = Math.max(0, Math.min(100, (evt.loaded / evt.total) * 100));
                setProgress(pct, "Uploading " + Math.round(pct) + "%", false);
              } else {
                setProgress(12, "Uploading\\u2026", true);
              }
            };
            xhr.onload = function () {
              if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
              reject(explainFailure("upload", xhr.status, xhr.getResponseHeader("content-type") || "", xhr.responseText || "", file));
            };
            xhr.onerror = function () { reject({ message: "Upload failed. Check the connection, request a fresh upload link, and try again.", retry: true }); };
            xhr.ontimeout = function () { reject({ message: "Upload timed out. Request a fresh upload link and try again.", retry: true }); };
            xhr.onabort = function () { reject({ message: "Upload canceled. Choose a file when you are ready to try again.", retry: true }); };
            setProgress(8, "Uploading\\u2026", true);
            xhr.send(file);
          });
        }
        function upload(file) {
          if (busy || locked) return;
          busy = true;
          var stage = "upload";
          setControls(false);
          setStatus("Uploading " + file.name + "\\u2026");
          setProgress(0, "Starting upload\\u2026", false);
          putFile(file)
            .then(function () {
              stage = "finalize";
              setStatus("Finalizing " + file.name + "\\u2026");
              setProgress(100, "Finalizing\\u2026", false);
              return fetch(d.complete_url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: file.name, mime_type: file.type || "application/octet-stream" }),
              });
            })
            .then(function (r) {
              return readJsonOrText(r).then(function (res) {
                if (!res.ok) throw explainFailure("finalize", res.status, res.contentType, res.text, file);
                return res.data || JSON.parse(res.text || "{}");
              });
            })
            .then(function (f) {
              locked = true;
              setStatus("Uploaded " + f.name + " (" + f.size + " bytes)", "done");
              setProgress(100, "Complete", false);
              emit("upload-complete", { file_id: d.file_id, name: f.name, size: f.size });
            })
            .catch(function (err) {
              if (!err || err.retry === undefined) err = explainFailure(stage, 0, "", String(err && err.message || err || ""), file);
              var message = String(err && err.message || err || "Upload failed. Request a fresh upload link and try again.");
              setStatus(message, "err");
              setProgress(100, "Failed", false);
              locked = !!(err && err.retry === false);
              setControls(err && err.retry === false ? false : true);
            })
            .then(function () {
              busy = false;
              if (!locked && !pick.disabled) setControls(true);
            });
        }
        resetProgress();
        pick.addEventListener("click", function () { if (!busy && !locked) input.click(); });
        input.addEventListener("change", function () { if (input.files[0]) upload(input.files[0]); });
        ["dragover", "dragenter"].forEach(function (ev) {
          zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("over"); });
        });
        ["dragleave", "drop"].forEach(function (ev) {
          zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove("over"); });
        });
        zone.addEventListener("drop", function (e) {
          if (!busy && !locked && e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
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
      .preview-expired, .preview-failed { border: 1px solid var(--yap-border); border-radius: 8px; padding: 16px; background: var(--yap-surface); color: var(--yap-fg-muted); font-size: 13px; }
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
        // A download link for every file type, sitting where the expiry note
        // used to. Uses the server's dedicated attachment link (download_url) so
        // it saves the file rather than rendering inline; a direct, non-stored
        // URL has no download_url, so fall back to the inline url. Omitted when
        // neither is a usable http(s) link (safeUrl collapses those to "#").
        var dlRaw = String(d.download_url != null ? d.download_url : (d.url != null ? d.url : ""));
        var dlUrl = safeUrl(d.download_url != null ? d.download_url : d.url);
        var dl = dlUrl !== "#" ? '<p class="dl-line"><a class="dl" href="' + dlUrl + '" download target="_blank" rel="noopener noreferrer">Download</a></p>' : "";
        root.innerHTML = '<div class="card"><div id="preview">' + inner + "</div>" + dl + "</div>";
        // Strict MCP Apps sandboxes (e.g. Claude) drop a target=_blank anchor, so
        // ask the host to open the link via ui/open-link. The anchor still works
        // on permissive hosts and is the fallback if the host has no ui/open-link;
        // origin-hosted pages (window.__YAP_DATA__) have no host and navigate natively.
        var dlEl = root.querySelector("a.dl");
        if (dlEl && dlUrl !== "#" && !window.__YAP_DATA__) {
          dlEl.addEventListener("click", function (e) {
            e.preventDefault();
            request("ui/open-link", { url: dlRaw }).catch(function () {
              try { window.open(dlRaw, "_blank", "noopener,noreferrer"); } catch (_e) {}
            });
          });
        }
        var media = root.querySelector("img,video,audio");
        if (media) {
          media.addEventListener(media.tagName === "IMG" ? "load" : "loadedmetadata", announceHeight);
          media.addEventListener("error", function () {
            var preview = document.getElementById("preview");
            if (!preview) return;
            var expiring = d.expires_in !== undefined && d.expires_in !== null;
            preview.className = expiring ? "preview-expired" : "preview-failed";
            preview.textContent = expiring ? "File preview expired - re-run to refresh" : "Preview failed to load";
            requestAnimationFrame(announceHeight);
          });
        }
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
  // The widget's own style + render, embedded as inert JSON so the shell can
  // recover and mount it IN PLACE when a host re-mounts with only tool-input
  // (no inline render) — no nested iframe, which strict hosts block.
  const srcScript = `<script type="application/json" data-yap-src>${escapeForInlineJson(
    JSON.stringify({ style: def.style, render: def.render }),
  )}</script>`;
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
${srcScript}
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
