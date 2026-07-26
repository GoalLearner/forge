# forge launcher
#
# Double-clickable entry point so starting forge doesn't require opening a
# terminal and typing commands. It:
#
#   1. asks which project folder to work in (remembering the last one)
#   2. starts forge there
#   3. shows what the session cost when you're done, and waits before closing
#
# Step 3 matters more than it looks: a console window launched from Explorer
# vanishes the instant its process exits, taking any final output with it.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null

$settingsPath = Join-Path $env:USERPROFILE '.forge\launcher.json'

function Get-LastFolder {
    if (Test-Path $settingsPath) {
        try {
            $saved = (Get-Content $settingsPath -Raw | ConvertFrom-Json).lastFolder
            if ($saved -and (Test-Path $saved)) { return $saved }
        } catch {
            # A corrupt settings file must never block launching.
        }
    }
    return [Environment]::GetFolderPath('Desktop')
}

function Save-LastFolder([string]$folder) {
    try {
        $dir = Split-Path $settingsPath -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        @{ lastFolder = $folder } | ConvertTo-Json | Set-Content $settingsPath -Encoding UTF8
    } catch {
        # Losing the remembered folder is a minor annoyance, not a failure.
    }
}

# --- Preflight -------------------------------------------------------------
# Catch the two setup problems that would otherwise surface as a confusing
# crash inside the TUI.

$forge = Get-Command forge -ErrorAction SilentlyContinue
if (-not $forge) {
    [System.Windows.Forms.MessageBox]::Show(
        "forge isn't installed on your PATH.`n`nOpen PowerShell in the forge project folder and run:`n`n    npm install`n    npm run build`n    npm link",
        'forge - not installed',
        'OK',
        'Error'
    ) | Out-Null
    exit 1
}

$hasKey = $false
foreach ($name in 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY') {
    if ([Environment]::GetEnvironmentVariable($name, 'User') -or [Environment]::GetEnvironmentVariable($name, 'Machine')) {
        $hasKey = $true
        break
    }
}
if (-not $hasKey) {
    $answer = [System.Windows.Forms.MessageBox]::Show(
        "No API key found.`n`nSet one in PowerShell, for example:`n`n    [Environment]::SetEnvironmentVariable(`"DEEPSEEK_API_KEY`",`"sk-...`",`"User`")`n`nStart forge anyway?",
        'forge - no API key',
        'YesNo',
        'Warning'
    )
    if ($answer -ne 'Yes') { exit 1 }
}

# --- Pick a project folder -------------------------------------------------

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Which project should forge work in?'
$dialog.SelectedPath = Get-LastFolder
$dialog.ShowNewFolderButton = $false

if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }

$project = $dialog.SelectedPath
Save-LastFolder $project

# --- Run -------------------------------------------------------------------

try {
    $Host.UI.RawUI.WindowTitle = "forge - $(Split-Path $project -Leaf)"
} catch {
    # Not fatal if the host doesn't allow it.
}

Set-Location $project
Clear-Host

Write-Host ''
Write-Host '  forge' -ForegroundColor Magenta -NoNewline
Write-Host "  $project" -ForegroundColor DarkGray
Write-Host '  /help for commands, ctrl-c twice to quit' -ForegroundColor DarkGray
Write-Host ''

& forge

# --- Wrap up ---------------------------------------------------------------
# Show the spend before the window disappears.

Write-Host ''
Write-Host '  ─────────────────────────────────────────' -ForegroundColor DarkGray
try { & forge --cost } catch { }
Write-Host ''
Write-Host '  Press any key to close...' -ForegroundColor DarkGray
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
