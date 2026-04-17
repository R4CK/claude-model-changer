# Claude Model Changer - installer (PowerShell for Windows)
#
# Runs preflight checks and ONLY installs if all prerequisites are met.
# Attempts to auto-install Node.js (>=16) via winget or choco if missing.

#Requires -Version 5.1

[CmdletBinding()]
param(
    [switch]$SkipAutoInstall
)

$ErrorActionPreference = 'Stop'
$PluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$MinNodeMajor = 16

function Write-Msg   { param($m) Write-Host $m -ForegroundColor Cyan }
function Write-Ok    { param($m) Write-Host "[OK]  $m" -ForegroundColor Green }
function Write-Warn2 { param($m) Write-Host "[WARN] $m" -ForegroundColor Yellow }
function Write-Fail  { param($m) Write-Host "[FAIL] $m" -ForegroundColor Red }

function Get-NodeMajor {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return 0 }
    try {
        $v = & node -e "console.log(process.versions.node.split('.')[0])" 2>$null
        return [int]$v
    } catch { return 0 }
}

function Try-InstallNode {
    Write-Msg "Attempting to install Node.js LTS automatically..."

    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
        Write-Msg "Using winget..."
        try {
            & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                        [System.Environment]::GetEnvironmentVariable('Path','User')
            return ($LASTEXITCODE -eq 0)
        } catch {
            Write-Warn2 "winget install failed: $_"
        }
    }

    $choco = Get-Command choco -ErrorAction SilentlyContinue
    if ($choco) {
        Write-Msg "Using Chocolatey..."
        try {
            & choco install nodejs-lts -y
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                        [System.Environment]::GetEnvironmentVariable('Path','User')
            return ($LASTEXITCODE -eq 0)
        } catch {
            Write-Warn2 "choco install failed: $_"
        }
    }

    Write-Warn2 "No package manager found. Install Node.js manually: https://nodejs.org/"
    return $false
}

# ---------------------------------------------------------------------------

Write-Msg "=== Claude Model Changer - Installer ==="
Write-Msg "Plugin directory: $PluginDir"
Write-Host ""

# 1. Node.js check
$nodeMajor = Get-NodeMajor
if ($nodeMajor -lt $MinNodeMajor) {
    Write-Warn2 "Node.js not found or too old (found major=$nodeMajor, need >= $MinNodeMajor)"
    if ($SkipAutoInstall) {
        Write-Fail "Auto-install skipped. Aborting."
        exit 1
    }
    if (Try-InstallNode) {
        $nodeMajor = Get-NodeMajor
        if ($nodeMajor -lt $MinNodeMajor) {
            Write-Fail "Auto-install completed but Node.js still < $MinNodeMajor. Open a new shell so PATH refreshes, then re-run. Aborting."
            exit 1
        }
        Write-Ok "Node.js installed: $(node --version)"
    } else {
        Write-Fail "Could not install Node.js automatically. Aborting."
        exit 1
    }
} else {
    Write-Ok "Node.js present: $(node --version)"
}

# 2. Central .claude directory check
$ClaudeHome = Join-Path $env:USERPROFILE '.claude'
if (-not (Test-Path -LiteralPath $ClaudeHome -PathType Container)) {
    Write-Fail "Central Claude directory not found: $ClaudeHome"
    Write-Warn2 "Run Claude Code at least once before installing plugins."
    exit 1
}
Write-Ok "Central Claude directory: $ClaudeHome"

# 3. Claude Code CLI check (informational only - plugin can install without it,
#    but you'll need it to actually use the plugin at runtime)
if (Get-Command claude -ErrorAction SilentlyContinue) {
    try {
        $claudeVer = & claude --version 2>$null
        Write-Ok "Claude Code CLI: $claudeVer"
    } catch {
        Write-Ok "Claude Code CLI: present"
    }
} else {
    Write-Warn2 "Claude Code CLI not on PATH. Install location is fine, but you'll need"
    Write-Warn2 "the 'claude' command to actually use the plugin."
}

# 4. Preflight (full structure, JSON validity, hook references, logs writable,
#    hook dry-run, central .claude/ writability, install-plugin.js present)
Write-Msg "Running preflight checks..."
& node (Join-Path $PluginDir 'scripts\preflight.js')
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Preflight failed. Installation aborted - see errors above."
    exit 1
}

# 5. Install via the project's own installer (copies to ~/.claude/plugins/cache/...
#    and registers in installed_plugins.json + settings.json)
Write-Msg "All prerequisites met. Installing plugin to central Claude directory..."
& node (Join-Path $PluginDir 'scripts\install-plugin.js')
if ($LASTEXITCODE -ne 0) {
    Write-Fail "scripts\install-plugin.js failed. Check output above."
    exit 1
}

Write-Host ""
Write-Ok "Installation complete. Restart Claude Code to activate the plugin."
