<#
  Conflux installer for Windows (PowerShell 5.1+ or 7).

    irm https://raw.githubusercontent.com/Gamface/Conflux/main/install.ps1 | iex

  Or, from a downloaded copy:  powershell -ExecutionPolicy Bypass -File install.ps1 [-Dir <path>] [-NoDesktop] [-NoBrowser] [-NoStart]

  What it does (and nothing else):
    1. Checks for Node.js 22.18+; if missing or too old, offers to install Node LTS with winget.
    2. Downloads the latest Conflux from GitHub into -Dir (default: %USERPROFILE%\Conflux).
       An existing install is updated in place; your data\ folder is kept.
    3. npm install (web UI build tools; Playwright for the browser coworker).
    4. Installs Chromium for Playwright (skip with -NoBrowser).
    5. Installs agent-cu for Windows desktop control (skip with -NoDesktop).
    6. Builds the web UI, creates a "Start Conflux" shortcut on the Desktop, and starts it.
#>
param(
  [string]$Dir = (Join-Path $env:USERPROFILE "Conflux"),
  [switch]$NoDesktop,
  [switch]$NoBrowser,
  [switch]$NoStart,
  [switch]$Yes
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    $m" -ForegroundColor Yellow }

function Get-NodeVersion {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return $null }
  try { return [version]((& node -v).TrimStart("v")) } catch { return $null }
}

function Update-PathFromRegistry {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

# 1. Node.js
Step "Checking Node.js (need 22.18 or newer)"
$v = Get-NodeVersion
if (-not $v -or $v -lt [version]"22.18.0") {
  if ($v) { Warn "Found Node $v, which is too old." } else { Warn "Node.js is not installed." }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Please install Node.js 22 LTS or newer from https://nodejs.org and run this installer again."
  }
  $answer = if ($Yes) { "y" } else { Read-Host "    Install Node.js LTS with winget now? [Y/n]" }
  if ($answer -match "^(n|no)$") { throw "Node.js 22.18+ is required. Install it from https://nodejs.org and re-run." }
  winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-source-agreements --accept-package-agreements
  Update-PathFromRegistry
  $v = Get-NodeVersion
  if (-not $v -or $v -lt [version]"22.18.0") { throw "Node.js install did not produce 22.18+. Open a new PowerShell window and run the installer again." }
}
Ok "Node $v"

# 2. Download Conflux
Step "Downloading Conflux into $Dir"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("conflux-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp "conflux.zip"
  Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/Gamface/Conflux/archive/refs/heads/main.zip" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = Get-ChildItem -Path $tmp -Directory | Where-Object { $_.Name -like "Conflux-*" } | Select-Object -First 1
  if (-not $src) { throw "Unexpected archive layout." }
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  # Copy everything except user data, so updates never touch data\ or your config.
  Get-ChildItem -Path $src.FullName -Force | Where-Object { $_.Name -notin @("data", "conflux.config.json", ".env") } |
    ForEach-Object { Copy-Item -Path $_.FullName -Destination $Dir -Recurse -Force }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
Ok "Files in $Dir"

Push-Location $Dir
try {
  # 3. Dependencies
  Step "Installing dependencies (npm install)"
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

  # 4. Browser
  if (-not $NoBrowser) {
    Step "Installing Chromium for the browser coworker"
    & npx playwright install chromium
    if ($LASTEXITCODE -ne 0) { Warn "Chromium install failed; browser tools will be unavailable (re-run: npx playwright install chromium)." }
  }

  # 5. Desktop control
  if (-not $NoDesktop) {
    Step "Installing agent-cu for Windows desktop control"
    & npm install -g agent-cu
    if ($LASTEXITCODE -ne 0) { Warn "agent-cu install failed; desktop tools will be unavailable (re-run: npm install -g agent-cu)." }
  }

  # 6. Build + shortcut
  Step "Building the web UI"
  & npm run build:web
  if ($LASTEXITCODE -ne 0) { throw "Web UI build failed." }

  $start = Join-Path $Dir "start-conflux.cmd"
  @"
@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:8787
node apps\server\src\main.ts
"@ | Set-Content -Path $start -Encoding ASCII

  try {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop "Start Conflux.lnk"))
    $lnk.TargetPath = $start
    $lnk.WorkingDirectory = $Dir
    $lnk.Description = "Start Conflux and open it in your browser"
    $lnk.Save()
    Ok "Desktop shortcut: Start Conflux"
  } catch { Warn "Could not create a Desktop shortcut; run $start instead." }

  Step "Checking the install"
  & node bin\conflux.ts doctor
} finally {
  Pop-Location
}

Write-Host "`nConflux is installed in $Dir" -ForegroundColor Green
Write-Host "  Start it any time with the 'Start Conflux' Desktop shortcut, then open http://127.0.0.1:8787"
Write-Host "  Real models: set ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY, or OLLAMA_HOST=http://localhost:11434"

if (-not $NoStart) {
  Step "Starting Conflux (close this window to stop it)"
  & (Join-Path $Dir "start-conflux.cmd")
}
