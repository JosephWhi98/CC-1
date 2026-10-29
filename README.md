# CC-1

A Teenage-Engineering-style desktop GUI for [Claude Code](https://claude.com/claude-code).
It runs the `claude` CLI for you and shows the conversation, tool calls, permission prompts,
usage and cost in a hardware-inspired interface, with 40+ themes and a pixel-art status display.

- **Server:** `server.js`, plain Node.js, no dependencies. It spawns `claude` per message and streams the output.
- **UI:** `public/index.html`, a single file with no build step.
- **Mac app:** `native/`, a small Swift `WKWebView` wrapper. Build with `./native/build.sh`.
- **Windows app:** `windows-native/`, a small C# + WebView2 shell (no Electron). Build with `./windows-native/build.sh` (works from macOS with the .NET SDK). `windows/` is the older Electron wrapper, kept as a fallback.

## Requirements
Claude Code installed and logged in (`claude --version` must work). Node.js 14 or newer for running from source.

## Run from source
```
node server.js          # then open http://localhost:4747
```
`PORT` changes the port. `PROJECTS_ROOT` seeds the project list from a folder's subfolders.

## What it stores
Everything is under `~/.cc-1/` (project list, cost ledger, uploaded images) plus your browser/webview
local storage for UI settings. Sessions are read from Claude Code's own history in `~/.claude/projects`.
No accounts, no telemetry, and no network calls other than the `claude` CLI itself, a check of the npm
registry for new Claude Code versions, a check of this repo's GitHub releases for new CC-1 versions (Settings → CHECK FOR UPDATES turns it off), and Google Fonts for the typefaces (the UI falls back to system
fonts offline).

## Security model
CC-1 can make an AI agent run commands and edit files on your machine, and has a built-in terminal.
Treat it like a terminal.

- The server listens on `127.0.0.1` only and rejects requests with an unexpected Host or Origin header,
  which blocks other websites from driving it (CSRF and DNS rebinding).
- File and session access is limited to folders you have added as projects.
- Any other program running as your user can still talk to the local server, as with any local dev tool.
- The default mode asks before edits and shell commands. **YOLO** mode skips every permission prompt.
  Only use it on projects you trust.

To report a vulnerability, please open a private security advisory on the repository instead of a public issue.

## Remote control from a phone (optional, off by default)
Settings → App → Remote → **Phone access** opens a second listener on your local network (port + 1) and shows a
QR code. Scan it with the iPhone camera, then use Safari's Share → Add to Home Screen to get a full-screen app.

- **Same Wi-Fi only, and only while the computer is awake.** Requests from outside private address ranges are refused,
  and the Host header must be a private IP or a `.local` name (blocks DNS rebinding).
- **Pairing:** the QR code carries a one-time code (valid 5 minutes, five wrong guesses cancel it). Redeeming it gives
  the phone a random 256-bit token in an HttpOnly, SameSite=Strict cookie. Only a hash is stored (`~/.cc-1/remote.json`).
  Revoke any device from Settings.
- **Limits for remote devices:** no terminal, no YOLO mode, no adding folders, no Claude account or settings changes,
  unless you turn on *Allow terminal & YOLO*. Permission prompts work from the phone.
- **Not encrypted:** this is plain HTTP on your LAN, so anyone on the same network could sniff the token. Pair only on a
  network you trust. The first launch may trigger a firewall prompt on macOS or Windows.

## Builds are unsigned
The Mac app is ad-hoc signed and not notarized (right-click, Open on first launch). The Windows build is
unsigned, so SmartScreen will warn ("More info", "Run anyway"). Windows builds bundle a pinned,
checksum-verified Electron version; update `V` in `windows/build-win.sh` to move to a newer one.

## License
MIT, see `LICENSE`.

## Releasing
Bump `VERSION` and add a `CHANGELOG.md` entry, commit, then run `./release.sh`. It builds the Mac and
Windows packages, tags `v<version>`, and creates the GitHub release (needs the `gh` CLI, or it tells you
what to upload by hand). Running copies of the app notice the new release; UPDATE NOW downloads the asset (checked against the SHA-256 GitHub publishes), unpacks it to `~/.cc-1/update`, and the Swift / C# shell swaps the app (`native/update.sh`, `windows-native/update.cmd`) and relaunches. Release assets must keep the names `CC-1-<ver>-mac.zip` and `CC-1-<ver>-win-x64-native.zip`.
