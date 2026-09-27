@echo off
rem Dugout Lab: opens the college football test page in your browser. Close this window to stop it.
cd /d "%~dp0\..\.."
if exist research\.venv\Scripts\python.exe (
  research\.venv\Scripts\python.exe research\lab\lab.py
) else (
  python research\lab\lab.py
)
pause
