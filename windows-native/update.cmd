@echo off
rem Swaps the installed CC-1 files for the staged ones, then relaunches. Started by CC-1.exe (from a temp copy of this file).
rem usage: update.cmd <pid-to-wait-for> <stage-dir> <install-dir> <backup-dir>
setlocal
set "PID=%~1"
set "STAGE=%~2"
set "DEST=%~3"
set "BAK=%~4"
:wait
tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul
if not errorlevel 1 (
  ping -n 2 127.0.0.1 >nul
  goto wait
)
rmdir /s /q "%BAK%" 2>nul
mkdir "%BAK%"
rem move only what the new package contains, so anything else in the folder is left alone
for /f "delims=" %%i in ('dir /b "%STAGE%"') do if exist "%DEST%\%%i" move "%DEST%\%%i" "%BAK%\" >nul
robocopy "%STAGE%" "%DEST%" /E /R:5 /W:1 /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto rollback
rmdir /s /q "%BAK%" 2>nul
start "" "%DEST%\CC-1.exe"
exit /b 0
:rollback
for /f "delims=" %%i in ('dir /b "%BAK%"') do (
  rmdir /s /q "%DEST%\%%i" 2>nul
  del /f /q "%DEST%\%%i" 2>nul
  move "%BAK%\%%i" "%DEST%\" >nul
)
start "" "%DEST%\CC-1.exe"
exit /b 1
