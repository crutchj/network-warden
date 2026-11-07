@echo off
cd /d "%~dp0\.."
npm run start:windows
if errorlevel 1 pause
