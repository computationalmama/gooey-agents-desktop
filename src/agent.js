// Runs inside one agent's iframe: loads that integration's widget from gooey.ai
// and reports branding, run links and outbound link clicks to the app shell.

const params = new URLSearchParams(location.search);
const integrationId = params.get("id");
const probeOnly = params.has("probe");
const LOAD_TIMEOUT_MS = 20000;

main();

// The widget shows its "Share conversation" button only on gooey.ai/chat/<name>-<ID>/ pages and
// builds the link from the page URL. Give this page that path, and have URL report gooey.ai as
// the host, so the button appears and the links it makes work for anyone.
function enableShareLinks() {
  history.replaceState(null, "", `/chat/agent-${encodeURIComponent(integrationId)}/`);
  const RealURL = window.URL;
  window.URL = class extends RealURL {
    constructor(url, base) {
      super(String(url) === location.href ? `https://gooey.ai${location.pathname}` : url, base);
    }
  };
}

function main() {
  if (!integrationId) return post({ type: "error", message: "Missing integration ID" });
  routeExternalLinks();
  if (!probeOnly) enableShareLinks();

  const script = document.createElement("script");
  // The name part of the path is ignored by gooey.ai; only the ID after the last "-" matters.
  script.src = `https://gooey.ai/chat/agent-${encodeURIComponent(integrationId)}/lib.js`;
  // gooey.ai answers 404 for an unknown ID, and the request also fails when offline.
  script.onerror = () => post({ type: "error", message: "No agent found for this ID, or gooey.ai is unreachable" });
  document.body.appendChild(script);

  waitForConfig()
    .then((config) => {
      const branding = config.branding || {};
      post({
        type: "ready",
        name: branding.name || "",
        photoUrl: branding.photoUrl || "",
        byLine: branding.byLine || "",
        // Not sent by gooey.ai yet; picked up automatically once the widget config includes it.
        workflowUrl: config.workflowUrl || "",
      });
      if (probeOnly) return;
      window.GooeyEmbed.mount({
        target: "#gooey-embed",
        mode: "fullscreen",
        showRunLink: true,
      });
      watchRunLinks();
      enableFileDrop();
    })
    .catch(() => post({ type: "error", message: "No agent found for this ID" }));
}

// Asked by the shell's chat search to show one conversation. The widget lists conversations
// in its open shadow root, so find the entry by its title and click it.
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "open-conversation") return;
  const root = document.querySelector("#gooey-embed > div")?.shadowRoot;
  if (!root) return;
  const title = String(event.data.title || "").trim().slice(0, 30);
  const target = [...root.querySelectorAll("button, a, li, div")]
    .filter((n) => !n.querySelector("button, a, li") && n.textContent.trim().startsWith(title))
    .pop();
  target?.click();
});

function post(msg) {
  window.parent.postMessage({ ...msg, source: "gooey-agent", integrationId }, location.origin);
}

// gooey.ai's lib.js loads the real widget, then sets GooeyEmbed.defaultConfig
// with this integration's settings. Poll for it rather than relying on the
// window "load" event, which may already have fired.
function waitForConfig() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const config = window.GooeyEmbed && window.GooeyEmbed.defaultConfig;
      if (config && config.integration_id) {
        clearInterval(timer);
        resolve(config);
      } else if (Date.now() - started > LOAD_TIMEOUT_MS) {
        clearInterval(timer);
        reject();
      }
    }, 100);
  });
}

// The widget renders "View run" links (showRunLink) into an open shadow root.
// Collect them in order so the shell can offer "Open last run".
function watchRunLinks() {
  const host = document.querySelector("#gooey-embed > div");
  const root = host && host.shadowRoot;
  if (!root) return setTimeout(watchRunLinks, 200);

  let lastSent = "";
  const scan = () => {
    const urls = [];
    for (const a of root.querySelectorAll('a[href*="run_id="]')) {
      if (!urls.includes(a.href)) urls.push(a.href);
    }
    const key = urls.join("\n");
    if (key === lastSent) return;
    lastSent = key;
    post({ type: "runs", runs: urls });
  };
  new MutationObserver(scan).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
  scan();
}

// Links in the widget open in a new tab, which a desktop webview can't do.
// Send them to the shell, which opens them in the default browser.
function routeExternalLinks() {
  document.addEventListener(
    "click",
    (event) => {
      const anchor = event.composedPath().find((el) => el.tagName === "A" && el.href);
      if (!anchor || !/^https?:/.test(anchor.href)) return;
      if (new URL(anchor.href).origin === location.origin) return;
      event.preventDefault();
      post({ type: "open", url: anchor.href });
    },
    true,
  );
  window.open = (url) => {
    if (url) post({ type: "open", url: new URL(url, location.href).href });
    return null;
  };
}

// Drag and drop files onto the chat. The widget only offers an attach button, which keeps hidden
// <input type=file> elements in this document (one for documents and audio, one for images and
// video). Hand each dropped file to the input that accepts its type, as if it had been picked.
function enableFileDrop() {
  const overlay = document.createElement("div");
  overlay.className = "drop-overlay";
  overlay.textContent = "Drop files to attach them to your message";
  document.body.appendChild(overlay);

  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");

  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.classList.add("show");
  });
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) {
      depth = 0;
      overlay.classList.remove("show");
    }
  });
  // Pasting a screenshot or copied image attaches it, like in the web chat.
  document.addEventListener(
    "paste",
    (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      attachFiles(files);
    },
    true,
  );
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.remove("show");
    attachFiles([...e.dataTransfer.files]);
  });
}

function attachFiles(files) {
  const inputs = [...document.querySelectorAll('body > input[type="file"]')].filter((i) => !i.hasAttribute("capture"));
  const accepts = (input, file) =>
    input.accept.split(",").some((rule) => {
      rule = rule.trim();
      return rule.endsWith("/*") ? file.type.startsWith(rule.slice(0, -1)) : rule === file.type;
    });
  const byInput = new Map();
  for (const file of files) {
    // Files with no MIME type (e.g. .md) go with the documents.
    const input = inputs.find((i) => accepts(i, file)) || inputs[0];
    if (!input) continue;
    byInput.set(input, [...(byInput.get(input) || []), file]);
  }
  for (const [input, list] of byInput) {
    const transfer = new DataTransfer();
    list.forEach((f) => transfer.items.add(f));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}
