@echo off
rem Starts Blockbench in dev mode: builds, watches for changes and launches Electron
cd /d "%~dp0"

if not exist node_modules (
	echo Installing dependencies...
	call npm install || goto :error
)

call npm run dev || goto :error
exit /b 0

:error
echo.
echo Blockbench dev mode stopped with an error.
pause
exit /b 1
