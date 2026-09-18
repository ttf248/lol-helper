@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Use the short Program Files path so parentheses in "Program Files (x86)"
rem cannot interfere with cmd.exe's parenthesized FOR syntax.
set "VSWHERE_DIR=%SystemDrive%\PROGRA~2\Microsoft Visual Studio\Installer"
set "VSWHERE=!VSWHERE_DIR!\vswhere.exe"
if not exist "!VSWHERE!" (
	echo Visual Studio Installer was not found.
	exit /b 1
)

set "VSINSTALL="
rem Reuse the existing Visual Studio Community 2022 installation.
set "PATH=!VSWHERE_DIR!;!PATH!"
for /f "delims=" %%i in ('vswhere.exe -latest -products Microsoft.VisualStudio.Product.Community -version "[17.0,18.0)" -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath') do (
	if not defined VSINSTALL set "VSINSTALL=%%i"
)
if not defined VSINSTALL (
	 echo A Visual Studio installation with the MSVC workload was not found.
	 exit /b 1
)

if /I "%1"=="tauri" if /I "%2"=="dev" (
	fltmc >nul 2>&1
	if errorlevel 1 (
		echo Tauri Dev requires an elevated VS Code window because Frank requests administrator execution.
		echo Restart VS Code with Run as administrator and launch this configuration again.
		exit /b 740
	)
)

call "!VSINSTALL!\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64
if errorlevel 1 exit /b %errorlevel%

cd /d "%~dp0.."
call pnpm %*
exit /b %errorlevel%
