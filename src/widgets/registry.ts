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
    send({ jsonrpc: "2.0", method: "ui/size-changed", params: { height: document.documentElement.scrollHeight } });
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
    if (m.method === "ui/render-data" || m.method === "ui/notifications/render-data") {
      var d = (m.params && m.params.data) || m.params || {};
      window.__yapOnData && window.__yapOnData(d);
    }
  });
  function onData(cb) {
    window.__yapOnData = function (d) { cb(d); requestAnimationFrame(announceHeight); };
    if (window.__YAP_DATA__) { window.__yapOnData(window.__YAP_DATA__); return; }
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
`;

const BASE_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, sans-serif; background: transparent; }
  .card { border: 1px solid rgba(128,128,128,.35); border-radius: 10px; padding: 14px; max-width: 560px; }
  .muted { opacity: .65; font-size: 12px; }
  .err { color: #c0392b; }
  button { font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid rgba(128,128,128,.5);
           background: rgba(128,128,128,.12); cursor: pointer; }
`;

export const WIDGETS: Record<string, WidgetDef> = {
  shell: {
    name: "shell",
    uri: `${UI_SCHEME_PREFIX}shell`,
    description:
      "Generic widget shell: reads any registered ui:// widget resource through the host and renders it with the supplied params. The statically-declared template for show_widget.",
    originHostable: false,
    style: ".shellframe { border: 0; width: 100%; }",
    render: `
      onData(function (d) {
        var root = document.getElementById("root");
        if (!d || !d.widget) { root.innerHTML = '<div class="card err">shell: no widget named</div>'; return; }
        request("resources/read", { uri: d.widget }).then(function (r) {
          var html = r && r.contents && r.contents[0] && r.contents[0].text;
          if (!html) throw new Error("empty widget resource");
          var f = document.createElement("iframe");
          f.className = "shellframe";
          f.setAttribute("sandbox", "allow-scripts");
          f.srcdoc = html;
          f.onload = function () {
            f.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/render-data", params: { data: d.params || {} } }, "*");
          };
          // Relay inner-widget messages (height, events, requests) up to the host.
          window.addEventListener("message", function (e) {
            if (e.source === f.contentWindow) {
              if (e.data && e.data.method === "ui/size-changed" && e.data.params) {
                f.style.height = e.data.params.height + "px";
              }
              send(e.data);
            }
          });
          root.innerHTML = "";
          root.appendChild(f);
        }).catch(function (err) {
          root.innerHTML = '<div class="card err">shell: could not load widget (' + (err && err.message || err) + ')</div>';
        });
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
      "Media card for show_file: images, audio, and video play inline; anything else gets a clean file card with a download button. Data: { kind, url, name?, mime_type?, size? }.",
    originHostable: true,
    style: `
      img, video { max-width: 100%; border-radius: 8px; display: block; }
      audio { width: 100%; }
      .filerow { display: flex; align-items: center; gap: 12px; }
      .fileicon { font-size: 28px; }
      a.dl { text-decoration: none; }
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
          '</div><div class="muted">' + esc(d.mime_type || "") + '</div></div>' +
          '<a class="dl" href="' + url + '" download><button>Download</button></a></div>';
        var expires = Number(d.expires_in) || 0;
        root.innerHTML = '<div class="card">' + inner +
          (expires ? '<p class="muted">Link expires in ' + expires + 's</p>' : "") + "</div>";
        var media = root.querySelector("img,video,audio");
        if (media) media.addEventListener(media.tagName === "IMG" ? "load" : "loadedmetadata", announceHeight);
      });
    `,
  },
};

function escapeForInlineJson(json: string): string {
  return json.replace(/</g, "\\u003c");
}

/**
 * Builds the complete, self-contained widget HTML. In client mode the page
 * waits for ui/render-data over postMessage; in origin mode the data is
 * embedded at serve time and there is no event channel.
 */
export function widgetHtml(name: string, mode: "client" | "origin", data?: unknown): string {
  const def = WIDGETS[name];
  if (!def) throw new Error(`unknown widget ${name}`);
  const dataScript =
    mode === "origin" ? `<script>window.__YAP_DATA__ = ${escapeForInlineJson(JSON.stringify(data ?? {}))};</script>` : "";
  return `<!doctype html>
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
}
