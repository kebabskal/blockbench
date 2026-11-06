@echo off
rem Makes this Blockbench checkout the one Windows uses (current user only):
rem double-clicked .bbmodel files, the Start menu and desktop shortcuts, and the "blockbench" command.
rem Run with /undo to hand everything back to the installed Blockbench.
setlocal
set "APP=%~dp0"
set "APP=%APP:~0,-1%"
set "ELECTRON=%APP%\node_modules\electron\dist\electron.exe"
set "INSTALLED=%LOCALAPPDATA%\Programs\Blockbench\Blockbench.exe"
set "PROGID=Blockbench Dev Project"
set "KEY=HKCU\Software\Classes"
set "SHORTCUTS='%APPDATA%\Microsoft\Windows\Start Menu\Programs\Blockbench.lnk','%USERPROFILE%\Desktop\Blockbench.lnk'"

if /i "%~1"=="/undo" (
	reg add "%KEY%\.bbmodel" /ve /d "Blockbench Project" /f >nul
	reg delete "%KEY%\%PROGID%" /f >nul 2>&1
	reg delete "%KEY%\.bbmodel\OpenWithProgids" /v "%PROGID%" /f >nul 2>&1
	powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; foreach ($p in @(%SHORTCUTS%)) { if (Test-Path $p) { $s = $ws.CreateShortcut($p); $s.TargetPath = '%INSTALLED%'; $s.Arguments = ''; $s.IconLocation = '%INSTALLED%,0'; $s.WorkingDirectory = '%LOCALAPPDATA%\Programs\Blockbench'; $s.Save() } }; $path = [Environment]::GetEnvironmentVariable('Path', 'User'); [Environment]::SetEnvironmentVariable('Path', (($path -split ';') | Where-Object { $_ -and $_ -ne '%APP%\bin' }) -join ';', 'User')"
	echo Everything opens in the installed Blockbench again.
	goto :refresh
)

if not exist "%ELECTRON%" (
	echo Electron is missing. Run dev.bat once first.
	exit /b 1
)

reg add "%KEY%\%PROGID%" /ve /d "Blockbench Project (dev)" /f >nul
reg add "%KEY%\%PROGID%\DefaultIcon" /ve /d "%APP%\build\bbmodel.ico" /f >nul
reg add "%KEY%\%PROGID%\shell\open\command" /ve /d "\"%ELECTRON%\" \"%APP%\" \"%%1\"" /f >nul
reg add "%KEY%\.bbmodel\OpenWithProgids" /v "%PROGID%" /t REG_NONE /f >nul
reg add "%KEY%\.bbmodel" /ve /d "%PROGID%" /f >nul

rem Shortcuts and the "blockbench" command on the user PATH
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; foreach ($p in @(%SHORTCUTS%)) { $s = $ws.CreateShortcut($p); $s.TargetPath = '%ELECTRON%'; $s.Arguments = '\"%APP%\"'; $s.IconLocation = '%APP%\build\icon.ico,0'; $s.WorkingDirectory = '%APP%'; $s.Save() }; $path = [Environment]::GetEnvironmentVariable('Path', 'User'); if (($path -split ';') -notcontains '%APP%\bin') { [Environment]::SetEnvironmentVariable('Path', (@($path -split ';' | Where-Object { $_ }) + '%APP%\bin') -join ';', 'User') }"
echo Blockbench now means %APP%

:refresh
rem Let Explorer pick up the new association and icons
powershell -NoProfile -Command "Add-Type -Namespace W -Name S -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, int f, System.IntPtr a, System.IntPtr b);'; [W.S]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)"
exit /b 0
