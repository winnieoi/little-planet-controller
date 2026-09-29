@echo off
rem ============================================================
rem  Little Planet - one-click launcher (Windows)
rem  Double-click this file to start the server and open the game.
rem ============================================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install it from https://nodejs.org
  pause
  exit /b 1
)

rem Open the browser shortly after the server starts
start /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8765/"

node server/server.js
pause
