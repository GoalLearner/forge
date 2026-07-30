@echo off
REM Double-clickable wrapper for the forge DESKTOP launcher.
REM
REM Mirrors Forge.cmd (which starts the terminal TUI), with two differences:
REM -WindowStyle Hidden, because a GUI app should not leave a console behind,
REM and `start ""` so this wrapper returns immediately instead of waiting.
REM -ExecutionPolicy Bypass applies to this one invocation only; it does not
REM change any machine or user policy.
setlocal
start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0forge-desktop-launcher.ps1"
