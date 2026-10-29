CC-1 — Claude Code field unit (Windows x64, native)

1. Unzip anywhere (e.g. C:\Apps\CC-1).
2. Run CC-1.exe.  (Windows SmartScreen may warn because the app is unsigned:
   "More info" -> "Run anyway".)
3. Click + FOLDER and choose a project.

Requirements
- Windows 10 or 11 with the Microsoft Edge WebView2 Runtime (already present on
  Windows 11 and up-to-date Windows 10; CC-1 tells you if it is missing).
- Claude Code installed and logged in:  https://claude.com/claude-code
  (open a terminal and make sure `claude --version` works)
- Claude Code on Windows also needs Git for Windows installed.

Notes
- Shortcuts: Ctrl+O add folder, Ctrl+N new session, Ctrl+, settings, F5 reload, F11 full screen.
- Your project list is stored in %USERPROFILE%\.cc-1\projects.json
- Sessions are read from Claude Code's own history in %USERPROFILE%\.claude\projects
- Window cache is stored in %LOCALAPPDATA%\CC-1
- The TERM drawer runs commands with PowerShell.
