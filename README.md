# Gooey Agents

A desktop app (built with [Tauri](https://tauri.app)) that keeps several Gooey.AI
`/agent` workflows side by side. Add each one by its web integration ID and switch
between them from the sidebar. Every agent keeps its own conversations.

When a reply looks wrong, **Open last run** opens that reply's run on gooey.ai so you
can inspect its inputs, outputs and errors. The arrow next to it lists every run in
the current conversation.

## Adding an agent

1. Open the agent on gooey.ai and go to its **Integrations** tab.
2. Copy the Web widget's integration ID (e.g. `OJw`) or its chat link
   (`https://gooey.ai/chat/<name>-<ID>/`).
3. In the app, click **Add agent** and paste it. The name and photo come from gooey.ai.

## Features

- **Search chats** (⌘K): full-text search across every saved chat in every agent.
- **Share conversation**: the icon in each chat's top-right copies a `gooey.ai/chat/<agent>/share/<id>` link.
- **Attach files**: drag and drop files onto a chat, or paste an image from the clipboard.
- **Pin and reorder**: drag agents in the sidebar, or use ⋯ → Pin to top.
- **Backups**: on first launch the app offers a daily backup (last 7 kept) to
  `Documents/Gooey Agents Backups`, or any folder you pick. A folder in iCloud Drive, Dropbox
  or Google Drive syncs to your other computers. **Back up now** saves a file anywhere, and
  **Restore** merges a backup file into the app. Backups are plain JSON and include chat text.

## How it works

- `src/index.html` + `src/app.js`: the app shell (sidebar, header, add dialog). The agent
  list is stored in the webview's localStorage.
- `src/agent.html` + `src/agent.js`: loaded in one iframe per agent. It loads
  `https://gooey.ai/chat/agent-<ID>/lib.js` (the same config the hosted chat page uses)
  and mounts the [gooey-web-widget](https://github.com/GooeyAI/gooey-web-widget) with
  `showRunLink: true`.
- Run links are read from the widget's (open) shadow DOM, so "Open last run" works
  without any widget changes. Links open in your default browser.

- **Open workflow** uses a link you save per agent, either when you add it or later with
  ⋯ → Edit agent. Run links can't stand in for it: gooey.ai builds them as
  `/agent/?run_id=…&uid=…`, without the workflow's ID. If the server's widget config
  starts including `workflowUrl`, the app fills the link in automatically.

Known gaps:
- Failed runs aren't flagged in the sidebar yet. A small `onRunComplete` callback in
  gooey-web-widget would fix that.

## Develop

Prerequisites: Node.js, Rust (`rustup`, stable), Xcode Command Line Tools on macOS.

```sh
npm install
npm run dev
```

There's no bundler. Edit files in `src/` and reload the window (Cmd+R).

## Build

```sh
npm run build
```

The `.app` and `.dmg` land in `src-tauri/target/release/bundle/`. The builds aren't
code-signed, so on first launch macOS will warn about an unidentified developer.
Right-click the app and choose Open to get past it once.

## Updates

Installed apps check for a new version at launch and every 6 hours. When one is found,
the sidebar shows **Update and restart**. Agents and chat history are kept.

- Updates come from `latest.json` on the newest *published* GitHub Release of
  `computationalmama/gooey-agents-desktop`. The repo must be public, because the app downloads
  without logging in.
- Every update is signed. The app only installs one whose signature matches the public
  key in `src-tauri/tauri.conf.json`.
- The private key is `~/.tauri/gooey-agents.key`, outside the repo. **Back it up somewhere
  safe** (e.g. the team password manager). If it's lost, installed apps can't be updated
  and everyone has to reinstall by hand. Never commit it.

### Shipping an update

1. Bump `version` in `src-tauri/tauri.conf.json` (and `package.json`), e.g. `0.1.1`.
2. Either:
   - **From your Mac:** run `scripts/release.sh "What changed"`. Create a GitHub Release
     tagged `v0.1.1`, upload the three files from `release/v0.1.1/`, and publish it.
   - **From CI:** add the repo secrets `TAURI_SIGNING_PRIVATE_KEY` (the contents of the key
     file) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty), then push the tag `v0.1.1`.
     CI builds macOS and Windows, then opens a draft release. Publish the draft.
3. Installed apps pick up the update within 6 hours, or on their next launch.

## Releases

Pushing a tag like `v0.1.0` runs `.github/workflows/release.yml`. It builds macOS
(Apple Silicon and Intel) and Windows installers and attaches them to a draft GitHub
Release.

## To do

- [ ] Fix the first-launch instructions in "Build" above. On recent macOS (Sequoia and later),
  right-click → Open no longer gets past the unidentified-developer warning. The steps are:
  open the app and click Done, then System Settings → Privacy & Security → Security →
  "Gooey Agents" was blocked → Open Anyway. Or run
  `xattr -dr com.apple.quarantine "/Applications/Gooey Agents.app"`. Ship the fix in the next release.
- [ ] Untested in the real app as of v0.1.3: the first-run backup dialog, Restore, deleting
  backups beyond the newest 7, drag-to-reorder and pin, drag-and-drop and paste attachments,
  and opening a chat from a search result.
