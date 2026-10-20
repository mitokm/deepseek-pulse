@echo off
setlocal
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul || set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

echo Starting DeepSeek Pulse...
"%NODE%" server.mjs
pause
