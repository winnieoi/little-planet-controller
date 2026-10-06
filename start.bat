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

rem Reuse the running local server if it is already open.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:8765/health' -TimeoutSec 8; if ($r.StatusCode -eq 200) { Start-Process 'http://localhost:8765/'; exit 0 } } catch { }; exit 1"
if %errorlevel%==0 exit /b 0

rem Open the browser shortly after the server starts
start /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:8765/"

node server/server.js
pause
