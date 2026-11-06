@echo off
rem Starts this Blockbench checkout, optionally opening a file: blockbench [file]
set "APP=%~dp0.."
for %%I in ("%APP%") do set "APP=%%~fI"
if "%~1"=="" (
	start "" "%APP%\node_modules\electron\dist\electron.exe" "%APP%"
) else (
	start "" "%APP%\node_modules\electron\dist\electron.exe" "%APP%" "%~f1"
)
