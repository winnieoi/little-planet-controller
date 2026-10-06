@echo off
setlocal
rem ============================================================
rem  口袋星球：漫游 - Windows 一键启动（中文文件名安全版）
rem
rem  重要：本文件必须保存为 ANSI / GBK 编码，不要存成 UTF-8。
rem  cmd.exe 是按系统 ANSI 代码页（简体中文 Windows 为 936）去读批处理
rem  文件的：存成 UTF-8 会让脚本里的中文变成乱码，导致 cd 到中文目录
rem  失败、窗口一闪就没了。VS Code 请用「GB2312 / GBK」重新打开保存。
rem ============================================================

set "PORT=8765"

rem 服务已在运行：直接开浏览器，不再重复启动第二个实例。
rem 用端口探测而不是 HTTP 请求：新开的 powershell 首次发请求要 1.7~4.9 秒，
rem 原来的 -TimeoutSec 1 必然超时，反而会重复启动并崩在 EADDRINUSE。
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',%PORT%); $c.Close(); Start-Process 'http://localhost:%PORT%/'; exit 0 } catch { }; exit 1"
if %errorlevel%==0 exit /b 0

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 没有找到 Node.js，请先安装: https://nodejs.org
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0"

rem 稍等服务器起来再开浏览器；用 ping 代替 timeout，避免 stdin 被重定向时报错
start /b cmd /c "ping -n 3 127.0.0.1 >nul & start "" http://localhost:%PORT%/"

node server/server.js
pause