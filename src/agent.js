// Runs inside one agent's iframe: loads that integration's widget from gooey.ai
// and reports branding, run links and outbound link clicks to the app shell.

const params = new URLSearchParams(location.search);
const integrationId = params.get("id");
const probeOnly = params.has("probe");
const LOAD_TIMEOUT_MS = 20000;

main();

function main() {
  if (!integrationId) return post({ type: "error", message: "Missing integration ID" });
  routeExternalLinks();

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
    })
    .catch(() => post({ type: "error", message: "No agent found for this ID" }));
}

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
