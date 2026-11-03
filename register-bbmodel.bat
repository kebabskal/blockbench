@echo off
rem Makes double-clicked .bbmodel files open in this Blockbench checkout (current user only).
rem Run with /undo to hand them back to the installed Blockbench.
setlocal
set "APP=%~dp0"
set "APP=%APP:~0,-1%"
set "PROGID=Blockbench Dev Project"
set "KEY=HKCU\Software\Classes"

if /i "%~1"=="/undo" (
	reg add "%KEY%\.bbmodel" /ve /d "Blockbench Project" /f >nul
	reg delete "%KEY%\%PROGID%" /f >nul 2>&1
	reg delete "%KEY%\.bbmodel\OpenWithProgids" /v "%PROGID%" /f >nul 2>&1
	echo .bbmodel files open in the installed Blockbench again.
	goto :refresh
)

if not exist "%APP%\node_modules\electron\dist\electron.exe" (
	echo Electron is missing. Run dev.bat once first.
	exit /b 1
)

reg add "%KEY%\%PROGID%" /ve /d "Blockbench Project (dev)" /f >nul
reg add "%KEY%\%PROGID%\DefaultIcon" /ve /d "%APP%\build\bbmodel.ico" /f >nul
reg add "%KEY%\%PROGID%\shell\open\command" /ve /d "\"%APP%\node_modules\electron\dist\electron.exe\" \"%APP%\" \"%%1\"" /f >nul
reg add "%KEY%\.bbmodel\OpenWithProgids" /v "%PROGID%" /t REG_NONE /f >nul
reg add "%KEY%\.bbmodel" /ve /d "%PROGID%" /f >nul
echo .bbmodel files now open in %APP%

:refresh
rem Let Explorer pick up the new association and icon
powershell -NoProfile -Command "Add-Type -Namespace W -Name S -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, int f, System.IntPtr a, System.IntPtr b);'; [W.S]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)"
exit /b 0
