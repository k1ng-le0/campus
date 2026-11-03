@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
rem env.local.bat (gitignored) may override PY; call it last
if exist "env.local.bat" call "env.local.bat"
echo 使用的 Python：%PY%
"%PY%" probe_cau.py
echo.
pause
