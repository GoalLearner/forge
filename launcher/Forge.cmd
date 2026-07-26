@echo off
REM Double-clickable wrapper for the forge launcher.
REM
REM .ps1 files are not executable by double-click on a default Windows install,
REM so this .cmd is the thing the desktop shortcut points at. -ExecutionPolicy
REM Bypass applies to this one invocation only; it does not change any machine
REM or user policy.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0forge-launcher.ps1"
