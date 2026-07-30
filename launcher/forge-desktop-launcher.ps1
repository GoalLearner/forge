# forge desktop launcher
#
# Double-clickable entry point for the Electron app, alongside
# forge-launcher.ps1 which starts the terminal TUI. The two are deliberately
# separate: the CLI needs a project folder chosen up front, the desktop app
# does not — it has its own project switcher and reopens the last real project
# by itself.
#
# This script is silent on success. A GUI app that leaves a console window
# behind looks broken, so the wrapper hides the console and everything below
# reports failure through a message box instead of Write-Host — there is no
# terminal for the user to read.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

# The repo root is the launcher's parent; resolved from this script's own path
# so the shortcut works no matter what directory Explorer starts it in.
$root = Split-Path $PSScriptRoot -Parent

function Fail([string]$message) {
    [System.Windows.Forms.MessageBox]::Show(
        $message,
        'forge desktop',
        'OK',
        'Error'
    ) | Out-Null
    exit 1
}

if (-not (Test-Path (Join-Path $root 'package.json'))) {
    Fail "Couldn't find the forge project.`n`nExpected it at:`n$root"
}

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
    Fail "Electron isn't installed.`n`nOpen PowerShell in:`n$root`n`nand run:`n`n    npm install"
}

# The main process is bundled, not run from source, so a missing or stale build
# is the one failure that would otherwise show as an empty black window.
$main = Join-Path $root 'dist\desktop\main.cjs'
if (-not (Test-Path $main)) {
    Fail "forge hasn't been built yet.`n`nOpen PowerShell in:`n$root`n`nand run:`n`n    npm run build"
}

# Start detached and exit immediately. -WorkingDirectory is what makes `electron .`
# resolve to this project; without it Electron would look in system32.
try {
    Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $root | Out-Null
} catch {
    Fail "Couldn't start forge.`n`n$($_.Exception.Message)"
}
