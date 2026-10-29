CC-1 — Claude Code field unit (Windows x64)

1. Unzip anywhere (e.g. C:\Apps\CC-1).
2. Run CC-1.exe.  (Windows SmartScreen may warn because the app is unsigned:
   "More info" -> "Run anyway".)
3. Click + FOLDER and choose a project.

Requirements
- Claude Code must be installed and logged in:  https://claude.com/claude-code
  (open a terminal and make sure `claude --version` works)
- Claude Code on Windows also needs Git for Windows installed.

Notes
- Your project list is stored in %USERPROFILE%\.cc-1\projects.json
- Sessions are read from Claude Code's own history in %USERPROFILE%\.claude\projects
- The TERM drawer runs commands with PowerShell.
