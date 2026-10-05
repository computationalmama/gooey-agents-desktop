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
  bindChatSearch();
  $("backup-btn").addEventListener("click", backUp);
  $("restore-btn").addEventListener("click", () => restore());
  bindAutoBackup();
  // A file dropped outside a chat would otherwise make the webview navigate to it.
  for (const type of ["dragover", "drop"]) document.addEventListener(type, (e) => e.preventDefault());
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openChatSearch();
    }
    if (e.key === "Escape") closeAllOverlays();
  });
  // Start every agent up front so status and unread counts work before it's opened.
  for (const agent of state.agents) ensureFrame(agent.id);
  if (state.selectedId) selectAgent(state.selectedId);
  render();
  $("check-update-btn").addEventListener("click", () => checkForUpdates(true));
  checkForUpdates();
  setInterval(checkForUpdates, UPDATE_CHECK_MS);
}

// Release builds fetch latest.json from GitHub Releases; the update is signature-checked
// against the public key in tauri.conf.json before it installs.
async function checkForUpdates(manual = false) {
  const updater = window.__TAURI__?.updater;
  if (!updater) {
    if (manual) showUpdateStatus("Updates only work in the installed app.");
    return;
  }
  if (pendingUpdate) return;
  const btn = $("check-update-btn");
  if (manual) {
    btn.disabled = true;
    btn.textContent = "Checking...";
  }
  try {
    pendingUpdate = await updater.check();
  } catch (err) {
    console.warn("Update check failed", err);
    if (manual) showUpdateStatus("Couldn't check for updates. Check your connection and try again.");
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = "Check for updates";
  }
  if (!pendingUpdate) {
    if (manual) showUpdateStatus("You're on the latest version.");
    return;
  }
  $("update-text").textContent = `Version ${pendingUpdate.version} is ready. Your agents and chats are kept.`;
  $("update-btn").hidden = false;
  $("update-banner").hidden = false;
  $("update-btn").onclick = installUpdate;
}

function showUpdateStatus(text) {
  $("update-text").textContent = text;
  $("update-btn").hidden = true;
  $("update-banner").hidden = false;
  clearTimeout(showUpdateStatus.timer);
  showUpdateStatus.timer = setTimeout(() => { $("update-banner").hidden = true; }, 5000);
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

// Chat search. The widget saves every conversation in IndexedDB, and the shell shares an
// origin with the agent frames, so it can read them directly and search the full text.
const CHAT_DB = "GOOEY_COPILOT_CONVERSATIONS_DB";
const MAX_RESULTS = 50;

function bindChatSearch() {
  $("search-chats-btn").addEventListener("click", openChatSearch);
  $("chat-search-dialog").addEventListener("click", (e) => {
    if (e.target === $("chat-search-dialog")) closeAllOverlays();
  });
  let timer;
  $("chat-search-input").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(runChatSearch, 120);
  });
  $("chat-search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("chat-search-results").querySelector("button")?.click();
  });
}

function openChatSearch() {
  closeAllOverlays();
  $("chat-search-dialog").hidden = false;
  $("chat-search-input").value = "";
  $("chat-search-results").replaceChildren();
  $("chat-search-input").focus();
}

function readConversations() {
  return new Promise((resolve) => {
    const open = indexedDB.open(CHAT_DB);
    open.onerror = () => resolve([]);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("conversations")) return resolve([]);
      const all = db.transaction("conversations").objectStore("conversations").getAll();
      all.onsuccess = () => resolve(all.result || []);
      all.onerror = () => resolve([]);
    };
  });
}

// Backup file: the agent list plus every saved conversation, as one JSON file.
async function buildBackup() {
  const conversations = await readConversations();
  return { app: "gooey-agents", version: 1, exportedAt: new Date().toISOString(), agents: state.agents, conversations };
}

// Automatic backups: one file per day in a folder the user picks once. Settings are in
// localStorage: { enabled, dir, decided, last (ISO time), error }.
const BACKUP_SETTINGS_KEY = "gooey-agents:backup";
const BACKUP_FOLDER = "Gooey Agents Backups";
const BACKUP_KEEP = 7;
const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
const BACKUP_STALE_MS = 14 * 24 * 60 * 60 * 1000;
const BACKUP_FILE = /^gooey-agents-backup-\d{4}-\d{2}-\d{2}\.json$/;
let backupTimer;
let draftDir = "";

function backupSettings() {
  try {
    return JSON.parse(localStorage.getItem(BACKUP_SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveBackupSettings(patch) {
  localStorage.setItem(BACKUP_SETTINGS_KEY, JSON.stringify({ ...backupSettings(), ...patch }));
  renderBackupStatus();
}

function bindAutoBackup() {
  if (!window.__TAURI__?.fs) {
    $("backup-status").hidden = true;
    return;
  }
  $("backup-status").addEventListener("click", openBackupDialog);
  $("backup-change").addEventListener("click", chooseBackupDir);
  $("backup-restore").addEventListener("click", () => {
    closeAllOverlays();
    restore(backupSettings().dir || undefined);
  });
  $("backup-off").addEventListener("click", () => {
    saveBackupSettings({ enabled: false, decided: true });
    closeAllOverlays();
  });
  $("backup-on").addEventListener("click", async () => {
    saveBackupSettings({ enabled: true, decided: true, dir: draftDir });
    closeAllOverlays();
    if (await autoBackup(true)) toast("Backup is on");
  });
  $("backup-dialog").addEventListener("click", (e) => {
    if (e.target === $("backup-dialog")) closeAllOverlays();
  });
  renderBackupStatus();
  // First run: offer to turn it on. After that, back up on launch and about hourly if a day has passed.
  if (!backupSettings().decided) setTimeout(openBackupDialog, 1200);
  autoBackup();
  setInterval(autoBackup, 60 * 60 * 1000);
}

async function defaultBackupDir() {
  const { path } = window.__TAURI__;
  return path.join(await path.documentDir(), BACKUP_FOLDER);
}

async function openBackupDialog() {
  const settings = backupSettings();
  draftDir = settings.dir || (await defaultBackupDir());
  $("backup-dir").textContent = tildePath(draftDir);
  $("backup-off").textContent = settings.enabled ? "Turn off" : "Not now";
  $("backup-on").textContent = settings.enabled ? "Save" : "Turn on";
  hideError("backup-error");
  closeAllOverlays();
  $("backup-dialog").hidden = false;
}

async function chooseBackupDir() {
  const picked = await window.__TAURI__.dialog.open({ directory: true, defaultPath: draftDir });
  if (!picked) return;
  draftDir = picked.endsWith(BACKUP_FOLDER) ? picked : await window.__TAURI__.path.join(picked, BACKUP_FOLDER);
  $("backup-dir").textContent = tildePath(draftDir);
}

function tildePath(path) {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

// Debounced so a burst of changes (drag-reordering, say) makes one backup.
function scheduleAutoBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => autoBackup(true), 5000);
}

async function autoBackup(force = false) {
  const settings = backupSettings();
  const tauri = window.__TAURI__;
  if (!settings.enabled || !settings.dir || !tauri?.fs) return false;
  if (!force && Date.now() - new Date(settings.last || 0) < BACKUP_EVERY_MS) return false;
  try {
    const { fs, path } = tauri;
    await fs.mkdir(settings.dir, { recursive: true });
    const backup = await buildBackup();
    const name = `gooey-agents-backup-${new Date().toLocaleDateString("sv")}.json`;
    await fs.writeTextFile(await path.join(settings.dir, name), JSON.stringify(backup));
    const old = (await fs.readDir(settings.dir)).map((f) => f.name).filter((n) => BACKUP_FILE.test(n)).sort();
    for (const stale of old.slice(0, -BACKUP_KEEP)) await fs.remove(await path.join(settings.dir, stale));
    saveBackupSettings({ last: new Date().toISOString(), error: "" });
    return true;
  } catch (err) {
    console.error("Auto-backup failed", err);
    saveBackupSettings({ error: "Backup failed" });
    return false;
  }
}

function renderBackupStatus() {
  const settings = backupSettings();
  const last = settings.last ? new Date(settings.last) : null;
  let text;
  if (!settings.enabled) text = "Auto-backup is off. Turn it on";
  else if (settings.error) text = "Last backup failed. Check the folder";
  else if (!last) text = "Auto-backup is on";
  else if (Date.now() - last > BACKUP_STALE_MS) text = "No recent backup. Check the folder";
  else text = `Last backup: ${last.toDateString() === new Date().toDateString() ? "today" : last.toLocaleDateString()} ${last.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  $("backup-status").textContent = text;
}
async function backUp() {
  const tauri = window.__TAURI__;
  if (!tauri?.dialog) return toast("Backups only work in the installed app");
  try {
    const path = await tauri.dialog.save({
      defaultPath: `gooey-agents-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "Gooey Agents backup", extensions: ["json"] }],
    });
    if (!path) return;
    const backup = await buildBackup();
    await tauri.fs.writeTextFile(path, JSON.stringify(backup));
    toast(`Backed up ${backup.agents.length} agents and ${backup.conversations.length} chats`);
  } catch (err) {
    console.error("Backup failed", err);
    toast("Couldn't save the backup");
  }
}

// Adds what's in a backup to this app. Agents already here are kept, and a chat with the same ID
// is replaced by the backed-up copy.
async function restore(defaultPath) {
  const tauri = window.__TAURI__;
  if (!tauri?.dialog) return toast("Restore only works in the installed app");
  try {
    const path = await tauri.dialog.open({ multiple: false, defaultPath, filters: [{ name: "Gooey Agents backup", extensions: ["json"] }] });
    if (!path) return;
    const backup = JSON.parse(await tauri.fs.readTextFile(path));
    if (backup.app !== "gooey-agents" || !Array.isArray(backup.agents) || !Array.isArray(backup.conversations)) {
      return toast("That isn't a Gooey Agents backup");
    }
    // The widget only lists chats saved under this install's user ID.
    let userId = localStorage.getItem("user_id");
    if (!userId) {
      userId = backup.conversations[0]?.user_id || crypto.randomUUID();
      localStorage.setItem("user_id", userId);
    }
    const added = backup.agents.filter((a) => !state.agents.some((m) => m.integrationId === a.integrationId));
    state.agents.push(...added);
    saveAgents();
    await writeConversations(backup.conversations.map((c) => ({ ...c, user_id: userId })));
    toast(`Restored ${added.length} agents and ${backup.conversations.length} chats`);
    setTimeout(() => location.reload(), 900);
  } catch (err) {
    console.error("Restore failed", err);
    toast("Couldn't read that backup");
  }
}

function writeConversations(conversations) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(CHAT_DB, 1);
    // Same shape the widget creates, in case it hasn't run yet.
    open.onupgradeneeded = () => open.result.createObjectStore("conversations", { keyPath: "id", autoIncrement: true });
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("conversations", "readwrite");
      const store = tx.objectStore("conversations");
      conversations.forEach((c) => store.put(c));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}

function messageText(m) {
  const parts = [m.content, m.input_prompt, m.raw_output_text, m.output_text].flat();
  return parts.filter((p) => typeof p === "string").join(" ");
}

async function runChatSearch() {
  const query = $("chat-search-input").value.trim().toLowerCase();
  const list = $("chat-search-results");
  list.replaceChildren();
  if (!query) return;
  const hits = [];
  for (const convo of await readConversations()) {
    const agent = state.agents.find((a) => a.integrationId === convo.bot_id);
    if (!agent) continue;
    const messages = convo.messages || [];
    const title = messages[0]?.input_prompt || convo.title || "Untitled chat";
    const match = messages.map(messageText).find((t) => t.toLowerCase().includes(query));
    if (!match && !title.toLowerCase().includes(query)) continue;
    hits.push({ agent, title, snippet: snippetAround(match || title, query), time: new Date(convo.timestamp || 0).getTime() || 0 });
  }
  hits.sort((a, b) => b.time - a.time);
  if (!hits.length) return list.append(el("li", { class: "empty-note", text: "No chats match your search" }));
  for (const hit of hits.slice(0, MAX_RESULTS)) {
    const item = el("button", { class: "chat-result", type: "button" });
    item.append(el("span", { class: "cr-title", text: hit.title }));
    item.append(el("span", { class: "cr-meta", text: `${displayName(hit.agent)}${hit.time ? " · " + new Date(hit.time).toLocaleDateString() : ""}` }));
    item.append(highlight(hit.snippet, query));
    item.addEventListener("click", () => openChat(hit.agent.id, hit.title));
    const li = el("li");
    li.append(item);
    list.append(li);
  }
}

function snippetAround(text, query) {
  const flat = text.replace(/\s+/g, " ");
  const at = Math.max(0, flat.toLowerCase().indexOf(query));
  const start = Math.max(0, at - 40);
  return (start ? "…" : "") + flat.slice(start, start + 140) + (start + 140 < flat.length ? "…" : "");
}

function highlight(text, query) {
  const node = el("span", { class: "cr-snippet" });
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) {
    node.textContent = text;
    return node;
  }
  node.append(text.slice(0, at), el("mark", { text: text.slice(at, at + query.length) }), text.slice(at + query.length));
  return node;
}

// The widget has no API for this, so the agent frame clicks the matching entry in its own
// conversation list (see agent.js).
function openChat(agentId, title) {
  selectAgent(agentId);
  frames[agentId].contentWindow?.postMessage({ type: "open-conversation", title }, location.origin);
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
  $("pin-btn").addEventListener("click", () => {
    const agent = currentAgent();
    agent.pinned = !agent.pinned;
    saveAgents();
    closeAllOverlays();
    render();
  });
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
  const matches = state.agents.filter((a) => !state.query || displayName(a).toLowerCase().includes(state.query) || a.integrationId.toLowerCase().includes(state.query));
  const visible = [...matches.filter((a) => a.pinned), ...matches.filter((a) => !a.pinned)];
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
    if (agent.pinned) item.insertAdjacentHTML("beforeend", '<svg class="pin" viewBox="0 0 24 24" aria-label="Pinned"><path d="M12 17v5M9 3h6l-1 7 4 4H6l4-4z"/></svg>');
    if (!state.query) bindReorder(item, agent);
    list.append(item);
  }
}

// Drag an agent onto another to place it just above that one. Dropping across the pinned
// boundary pins or unpins it to match.
function bindReorder(item, agent) {
  item.draggable = true;
  item.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/x-gooey-agent", agent.id);
    e.dataTransfer.effectAllowed = "move";
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", () => item.classList.remove("dragging"));
  item.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].includes("text/x-gooey-agent")) return;
    e.preventDefault();
    item.classList.add("drop-before");
  });
  item.addEventListener("dragleave", () => item.classList.remove("drop-before"));
  item.addEventListener("drop", (e) => {
    const id = e.dataTransfer.getData("text/x-gooey-agent");
    item.classList.remove("drop-before");
    const moved = state.agents.find((a) => a.id === id);
    if (!moved || moved === agent) return;
    e.preventDefault();
    state.agents = state.agents.filter((a) => a !== moved);
    state.agents.splice(state.agents.indexOf(agent), 0, moved);
    moved.pinned = !!agent.pinned;
    saveAgents();
    render();
  });
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
  $("pin-btn").textContent = agent.pinned ? "Unpin from top" : "Pin to top";
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
  $("chat-search-dialog").hidden = true;
  $("backup-dialog").hidden = true;
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
  scheduleAutoBackup();
}

// Last, so every top-level const above is initialised before init() uses it.
init();
