// App shell: the agent list, one iframe per agent (kept alive so conversations
// survive switching), and the run / workflow shortcuts.

const STORAGE_KEY = "gooey-agents:v1";
const SELECTED_KEY = "gooey-agents:selected";
const AVATAR_COLORS = ["#00665c", "#302ad8", "#c11417", "#0a1021", "#2a28ba", "#00998a"];
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;

const state = {
  agents: loadAgents(),
  selectedId: localStorage.getItem(SELECTED_KEY),
  // Per-agent runtime info, not persisted: { status, runs, unread }
  live: {},
  query: "",
};
const frames = {};
let pendingUpdate = null;
const $ = (id) => document.getElementById(id);

init();

function init() {
  for (const agent of state.agents) ensureLive(agent.id);
  if (!state.agents.some((a) => a.id === state.selectedId)) {
    state.selectedId = state.agents[0]?.id || null;
  }
  window.addEventListener("message", onAgentMessage);
  bindHeader();
  bindAddDialog();
  bindEditDialog();
  bindEmptyState();
  $("search").addEventListener("input", (e) => {
    state.query = e.target.value.trim().toLowerCase();
    renderSidebar();
  });
  document.addEventListener("click", closePopoversOnOutsideClick);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllOverlays();
  });
  // Start every agent up front so status and unread counts work before it's opened.
  for (const agent of state.agents) ensureFrame(agent.id);
  if (state.selectedId) selectAgent(state.selectedId);
  render();
  checkForUpdates();
  setInterval(checkForUpdates, UPDATE_CHECK_MS);
}

// Release builds fetch latest.json from GitHub Releases; the update is signature-checked
// against the public key in tauri.conf.json before it installs.
async function checkForUpdates() {
  const updater = window.__TAURI__?.updater;
  if (!updater || pendingUpdate) return;
  try {
    pendingUpdate = await updater.check();
  } catch (err) {
    console.warn("Update check failed", err);
    return;
  }
  if (!pendingUpdate) return;
  $("update-text").textContent = `Version ${pendingUpdate.version} is ready. Your agents and chats are kept.`;
  $("update-banner").hidden = false;
  $("update-btn").onclick = installUpdate;
}

async function installUpdate() {
  const btn = $("update-btn");
  btn.disabled = true;
  let total = 0;
  let received = 0;
  try {
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength || 0;
      if (event.event === "Progress") received += event.data.chunkLength;
      btn.textContent = total ? `Downloading ${Math.round((received / total) * 100)}%` : "Downloading";
    });
    btn.textContent = "Restarting";
    await window.__TAURI__.process.relaunch();
  } catch (err) {
    console.error("Update failed", err);
    btn.disabled = false;
    btn.textContent = "Try again";
    $("update-text").textContent = "The update couldn't be installed. Check your connection and try again.";
  }
}

function onAgentMessage(event) {
  if (event.origin !== location.origin) return;
  const msg = event.data;
  if (!msg || msg.source !== "gooey-agent") return;

  if (event.source === $("probe").contentWindow) return onProbeMessage(msg);

  const agent = state.agents.find((a) => frames[a.id]?.contentWindow === event.source);
  if (!agent) return;
  const live = state.live[agent.id];

  if (msg.type === "open") {
    openExternal(msg.url);
  } else if (msg.type === "ready") {
    live.status = "ready";
    // Keep the gooey.ai name and photo fresh unless the user renamed the agent.
    agent.remoteName = msg.name || agent.remoteName;
    agent.photoUrl = msg.photoUrl || "";
    // Only if gooey.ai starts sending it; a link the user saved always wins.
    if (msg.workflowUrl && !agent.workflowUrl) agent.workflowUrl = msg.workflowUrl;
    saveAgents();
  } else if (msg.type === "error") {
    live.status = "error";
    live.error = msg.message;
  } else if (msg.type === "runs") {
    const added = msg.runs.length - live.runs.length;
    if (added > 0 && agent.id !== state.selectedId) live.unread += added;
    live.runs = msg.runs;
  }
  render();
}

function bindHeader() {
  $("last-run-btn").addEventListener("click", () => {
    const runs = currentLive().runs;
    if (runs.length) openExternal(runs[runs.length - 1]);
  });
  $("runs-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover("runs-popover", "runs-toggle");
  });
  $("workflow-btn").addEventListener("click", () => {
    const url = currentAgent().workflowUrl;
    if (url) openExternal(url);
    else openEditDialog();
  });
  $("edit-btn").addEventListener("click", openEditDialog);
  $("reload-btn").addEventListener("click", () => reloadAgent(state.selectedId));
  $("more-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    togglePopover("more-menu", "more-btn");
  });
  $("copy-id-btn").addEventListener("click", () => {
    copyText(currentAgent().integrationId, "Integration ID copied");
    closeAllOverlays();
  });
  $("open-chat-btn").addEventListener("click", () => {
    openExternal(chatUrl(currentAgent().integrationId));
    closeAllOverlays();
  });
  $("remove-btn").addEventListener("click", onRemoveClick);
  $("runs-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-url]");
    if (!btn) return;
    if (btn.dataset.action === "copy") copyText(btn.dataset.url, "Run link copied");
    else openExternal(btn.dataset.url);
  });
}

function onRemoveClick() {
  const btn = $("remove-btn");
  // Two-step confirm: native confirm() dialogs aren't reliable in the webview.
  if (!btn.dataset.armed) {
    btn.dataset.armed = "1";
    btn.textContent = "Click again to remove";
    return;
  }
  removeAgent(state.selectedId);
  closeAllOverlays();
}

function bindAddDialog() {
  let probeTimer;
  $("add-btn").addEventListener("click", openAddDialog);
  $("add-cancel").addEventListener("click", closeAllOverlays);
  $("add-dialog").addEventListener("click", (e) => {
    if (e.target === $("add-dialog")) closeAllOverlays();
  });
  $("add-input").addEventListener("input", () => {
    clearTimeout(probeTimer);
    hideError("add-error");
    const id = parseIntegrationId($("add-input").value);
    if (!id) return showPreview(null);
    showPreview({ id, state: "loading" });
    probeTimer = setTimeout(() => startProbe(id), 400);
  });
  $("add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = parseIntegrationId($("add-input").value);
    if (!id) return showError("add-error", "That doesn't look like an integration ID or a gooey.ai/chat link.");
    const workflowUrl = normalizeUrl($("add-workflow").value);
    if (workflowUrl === null) return showError("add-error", "The workflow link should be a web address, like gooey.ai/copilot/my-agent-abc123/");
    if (!addAgent(id, $("add-name").value.trim(), workflowUrl)) return showError("add-error", "This agent is already in your list.");
    closeAllOverlays();
  });
}

function bindEditDialog() {
  $("edit-cancel").addEventListener("click", closeAllOverlays);
  $("edit-dialog").addEventListener("click", (e) => {
    if (e.target === $("edit-dialog")) closeAllOverlays();
  });
  $("edit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const workflowUrl = normalizeUrl($("edit-workflow").value);
    if (workflowUrl === null) return showError("edit-error", "The workflow link should be a web address, like gooey.ai/copilot/my-agent-abc123/");
    const agent = currentAgent();
    agent.customName = $("edit-name").value.trim();
    agent.workflowUrl = workflowUrl;
    saveAgents();
    closeAllOverlays();
    render();
  });
}

function openEditDialog() {
  const agent = currentAgent();
  closeAllOverlays();
  hideError("edit-error");
  $("edit-sub").textContent = `Integration ID ${agent.integrationId}`;
  $("edit-name").value = agent.customName || "";
  $("edit-name").placeholder = agent.remoteName || "";
  $("edit-workflow").value = agent.workflowUrl || "";
  $("edit-dialog").hidden = false;
  (agent.workflowUrl ? $("edit-name") : $("edit-workflow")).focus();
}

function bindEmptyState() {
  $("empty-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = parseIntegrationId($("empty-input").value);
    if (!id) return showError("empty-error", "That doesn't look like an integration ID or a gooey.ai/chat link.");
    $("empty-input").value = "";
    hideError("empty-error");
    addAgent(id, "");
  });
}

function openAddDialog() {
  $("add-input").value = "";
  $("add-name").value = "";
  $("add-workflow").value = "";
  hideError("add-error");
  showPreview(null);
  closeAllOverlays();
  $("add-dialog").hidden = false;
  $("add-input").focus();
}

function startProbe(id) {
  const probe = $("probe");
  probe.dataset.id = id;
  probe.src = `agent.html?probe=1&id=${encodeURIComponent(id)}`;
}

function onProbeMessage(msg) {
  if (msg.integrationId !== $("probe").dataset.id) return;
  if (parseIntegrationId($("add-input").value) !== msg.integrationId) return;
  if (msg.type === "ready") {
    showPreview({ id: msg.integrationId, state: "found", name: msg.name, photoUrl: msg.photoUrl, byLine: msg.byLine });
    if (!$("add-name").value) $("add-name").placeholder = msg.name || "";
  } else if (msg.type === "error") {
    showPreview({ id: msg.integrationId, state: "missing" });
  }
}

function showPreview(info) {
  $("add-preview").hidden = !info;
  if (!info) return;
  const name = info.name || (info.state === "loading" ? "Looking up agent" : `Agent ${info.id}`);
  paintAvatar($("add-preview-avatar"), { name, photoUrl: info.photoUrl, color: colorFor(info.id) });
  $("add-preview-name").textContent = name;
  $("add-preview-meta").textContent = [`ID ${info.id}`, info.byLine].filter(Boolean).join(" · ");
  const label = { loading: "Checking", found: "Found", missing: "Not found" }[info.state];
  $("add-preview-state").textContent = label;
  $("add-preview-state").className = `preview-state ${info.state === "found" ? "ok" : info.state === "missing" ? "bad" : ""}`;
}

function addAgent(integrationId, customName, workflowUrl = "") {
  if (state.agents.some((a) => a.integrationId === integrationId)) return false;
  const agent = {
    id: `${integrationId}-${Date.now().toString(36)}`,
    integrationId,
    customName,
    workflowUrl,
    remoteName: "",
    photoUrl: "",
    color: colorFor(integrationId),
  };
  state.agents.push(agent);
  ensureLive(agent.id);
  saveAgents();
  selectAgent(agent.id);
  render();
  return true;
}

function removeAgent(id) {
  state.agents = state.agents.filter((a) => a.id !== id);
  delete state.live[id];
  frames[id]?.remove();
  delete frames[id];
  saveAgents();
  if (state.selectedId === id) {
    state.selectedId = state.agents[0]?.id || null;
    if (state.selectedId) selectAgent(state.selectedId);
  }
  render();
}

function selectAgent(id) {
  state.selectedId = id;
  localStorage.setItem(SELECTED_KEY, id);
  ensureFrame(id);
  state.live[id].unread = 0;
  for (const [frameId, frame] of Object.entries(frames)) frame.hidden = frameId !== id;
  closeAllOverlays();
  render();
}

function reloadAgent(id) {
  const agent = state.agents.find((a) => a.id === id);
  if (!agent) return;
  Object.assign(state.live[id], { status: "loading", runs: [], unread: 0 });
  frames[id].src = frameSrc(agent);
  render();
}

function ensureFrame(id) {
  if (frames[id]) return;
  const agent = state.agents.find((a) => a.id === id);
  const frame = document.createElement("iframe");
  frame.title = displayName(agent);
  frame.allow = "microphone; clipboard-write";
  frame.src = frameSrc(agent);
  $("frames").appendChild(frame);
  frames[id] = frame;
}

function render() {
  renderSidebar();
  renderMain();
}

function renderSidebar() {
  const list = $("agent-list");
  list.replaceChildren();
  const visible = state.agents.filter((a) => !state.query || displayName(a).toLowerCase().includes(state.query) || a.integrationId.toLowerCase().includes(state.query));
  if (state.agents.length && !visible.length) {
    list.append(el("div", { class: "no-results", text: "No agents match your search" }));
  }
  for (const agent of visible) {
    const live = state.live[agent.id];
    const item = el("button", { class: `agent-item${agent.id === state.selectedId ? " active" : ""}`, type: "button" });
    item.addEventListener("click", () => selectAgent(agent.id));
    const avatar = el("span", { class: "avatar" });
    paintAvatar(avatar, { name: displayName(agent), photoUrl: agent.photoUrl, color: agent.color });
    const status = el("span", { class: "status" });
    status.append(el("span", { class: `dot ${live.status}` }), statusLabel(live));
    const text = el("span", { class: "text" });
    text.append(el("span", { class: "name", text: displayName(agent) }), status);
    item.append(avatar, text);
    if (live.unread) item.append(el("span", { class: "badge", text: String(live.unread), "aria-label": `${live.unread} new replies` }));
    list.append(item);
  }
}

function renderMain() {
  const agent = currentAgent();
  $("empty").hidden = !!agent;
  $("agent-header").hidden = !agent;
  $("frames").hidden = !agent;
  if (!agent) return $("empty-input").focus();

  const live = currentLive();
  paintAvatar($("h-avatar"), { name: displayName(agent), photoUrl: agent.photoUrl, color: agent.color });
  $("h-name").textContent = displayName(agent);
  $("h-id").textContent = `ID ${agent.integrationId}`;
  $("h-status").textContent = live.status === "error" ? live.error : `${live.runs.length} ${live.runs.length === 1 ? "run" : "runs"} in this conversation`;
  $("last-run-btn").disabled = !live.runs.length;
  $("last-run-btn").title = live.runs.length ? "Open the latest reply's run on gooey.ai" : "Send a message first";
  $("workflow-btn").title = agent.workflowUrl ? agent.workflowUrl : "Add this agent's workflow link";
  renderRuns(live.runs);
}

function renderRuns(runs) {
  const list = $("runs-list");
  list.replaceChildren();
  if (!runs.length) {
    list.append(el("li", { class: "empty-runs", text: "No runs yet. Send a message and each reply will show up here." }));
    return;
  }
  [...runs].reverse().forEach((url, i) => {
    const n = runs.length - i;
    const runId = new URL(url).searchParams.get("run_id") || "";
    const li = el("li");
    const text = el("span", { class: "run-text" });
    text.append(el("span", { text: `Reply ${n}${i === 0 ? " (latest)" : ""}` }), el("small", { text: `run ${runId}` }));
    const copy = el("button", { class: "copy-btn", type: "button", "aria-label": "Copy run link", "data-url": url, "data-action": "copy" });
    copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>';
    const open = el("button", { class: "link-btn", type: "button", text: "Open", "data-url": url });
    li.append(text, copy, open);
    list.append(li);
  });
}

function togglePopover(popoverId, buttonId) {
  const willOpen = $(popoverId).hidden;
  closeAllOverlays();
  $(popoverId).hidden = !willOpen;
  $(buttonId).setAttribute("aria-expanded", String(willOpen));
}

function closePopoversOnOutsideClick(e) {
  if (e.target.closest(".popover")) return;
  for (const id of ["runs-popover", "more-menu"]) $(id).hidden = true;
  resetRemoveButton();
}

function closeAllOverlays() {
  $("runs-popover").hidden = true;
  $("more-menu").hidden = true;
  $("add-dialog").hidden = true;
  $("edit-dialog").hidden = true;
  $("runs-toggle").setAttribute("aria-expanded", "false");
  $("more-btn").setAttribute("aria-expanded", "false");
  resetRemoveButton();
}

function resetRemoveButton() {
  const btn = $("remove-btn");
  delete btn.dataset.armed;
  btn.textContent = "Remove agent";
}

function openExternal(url) {
  if (!/^https?:\/\//.test(url)) return;
  const opener = window.__TAURI__?.opener;
  if (opener) opener.openUrl(url);
  else window.open(url, "_blank", "noopener");
}

function copyText(text, message) {
  navigator.clipboard.writeText(text).then(() => toast(message), () => toast("Couldn't copy"));
}

function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 1800);
}

function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = false;
}

function hideError(id) {
  $(id).hidden = true;
}

function paintAvatar(node, { name, photoUrl, color }) {
  node.style.backgroundColor = photoUrl ? "transparent" : color;
  node.style.backgroundImage = photoUrl ? `url("${photoUrl.replace(/"/g, "%22")}")` : "";
  node.textContent = photoUrl ? "" : initials(name);
}

function statusLabel(live) {
  return { loading: "Loading", ready: "Ready", error: "Couldn't load" }[live.status];
}

function currentAgent() {
  return state.agents.find((a) => a.id === state.selectedId) || null;
}

function currentLive() {
  return state.live[state.selectedId];
}

function ensureLive(id) {
  state.live[id] ||= { status: "loading", runs: [], unread: 0, error: "" };
}

function displayName(agent) {
  return agent.customName || agent.remoteName || `Agent ${agent.integrationId}`;
}

function frameSrc(agent) {
  return `agent.html?id=${encodeURIComponent(agent.integrationId)}`;
}

function chatUrl(integrationId) {
  return `https://gooey.ai/chat/agent-${encodeURIComponent(integrationId)}/`;
}

// "" for blank input, null if it isn't a web address, else an https URL.
function normalizeUrl(input) {
  const value = (input || "").trim();
  if (!value) return "";
  try {
    const url = new URL(/^https?:\/\//.test(value) ? value : `https://${value}`);
    return url.hostname.includes(".") ? url.toString() : null;
  } catch {
    return null;
  }
}

// Accepts "OJw", "gooey.ai/chat/some-name-OJw/", or a full https URL.
function parseIntegrationId(input) {
  const value = (input || "").trim();
  const chat = value.match(/\/chat\/([^/?#]+)/);
  const id = chat ? chat[1].split("-").pop() : value;
  return /^[A-Za-z0-9]{2,32}$/.test(id) ? id : null;
}

function initials(name) {
  const words = (name || "?").replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || "?") + (words[1]?.[0] || "")).toUpperCase();
}

function colorFor(key) {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function el(tag, attrs = {}) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  return node;
}

function loadAgents() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveAgents() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.agents));
}
