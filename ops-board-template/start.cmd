@echo off
rem ---------------------------------------------------------------------------
rem  ops-board launcher.
rem  NOTE: keep this file pure ASCII. cmd.exe parses .cmd with the system ANSI
rem  code page (GBK here), so any UTF-8 Chinese in this file breaks the parser.
rem  Chinese messages are printed by node (serve.mjs) instead.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"

if not exist "dist\index.html" (
  echo [1/2] Generating page...
  call npm run build
)

echo.
echo   Starting ops-board. A browser will open in a moment.
echo   Keep this window open - closing it stops the board.
echo.
echo   This window only renders the board. To ask AI, open the board
echo   inside Harness (sidebar - Project boards).
echo.

rem wait ~2s so the browser does not arrive before the server
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul && start http://127.0.0.1:8790/"

node scripts\serve.mjs

echo.
echo Server stopped. Press any key to close.
pause >nul
