@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.18+ 或 24：https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules\zod (
  call npm install --no-audit --no-fund
  if errorlevel 1 exit /b 1
)
node scripts/start-local.mjs
pause
