@echo off
REM Double-click to start the TACOCRAFT LAN server (needs Node.js from https://nodejs.org)
cd /d "%~dp0"
if not exist node_modules (echo Installing for the first time, this needs internet once... & call npm install)
node server.js
pause
