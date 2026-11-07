<#
  Conflux installer for Windows.

  Run from PowerShell in the folder that contains (or should contain) Conflux:
      powershell -ExecutionPolicy Bypass -File install.ps1            # install + start
      powershell -ExecutionPolicy Bypass -File install.ps1 -NoBrowser # skip Chromium download
      powershell -ExecutionPolicy Bypass -File install.ps1 -NoStart

  What it does (each step is skipped if already done):
    1. Node.js 22.18+ (via winget if missing or too old)
    2. Conflux source: uses this folder if it is a Conflux checkout, else clones/downloads from GitHub
    3. npm install (web UI deps, optional Playwright) and builds the web UI if needed
    4. agent-cu (desktop control) via npm -g
    5. Chromium for the coworkers' browsers (Playwright)
    6. Creates start-conflux.cmd and a Desktop shortcut, then starts Conflux
#>
param(
  [switch]$NoBrowser,
  [switch]$NoDesktop,
  [switch]$NoStart,
  [string]$Repo = "https://github.com/Gamface/Conflux"
)
$ErrorActionPreference = "Stop"
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

# ── 1. Node.js ─────────────────────────────────────────────────────────────
Step "Checking Node.js (need 22.18 or newer)"
$needNode = $true
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $v = (& node -v).TrimStart("v").Split(".")
  if ([int]$v[0] -gt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -ge 18)) { $needNode = $false; Ok "Node $(& node -v) found" }
  else { Warn "Node $(& node -v) is too old" }
}
if ($needNode) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Node 22.18+ is required. Install the LTS from https://nodejs.org and re-run this script."
  }
  Write-Host "    Installing Node.js LTS with winget…"
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node was installed but is not on PATH yet. Open a new PowerShell window and re-run." }
  Ok "Node $(& node -v) installed"
}

# ── 2. Source ──────────────────────────────────────────────────────────────
Step "Locating Conflux source"
$here = $PSScriptRoot
if (-not $here) { $here = (Get-Location).Path }
function Is-Conflux($p) { (Test-Path (Join-Path $p "package.json")) -and (Select-String -Path (Join-Path $p "package.json") -Pattern '"name": "conflux"' -Quiet) }
if (Is-Conflux $here) { $root = $here }
elseif (Is-Conflux (Join-Path $here "conflux")) { $root = Join-Path $here "conflux" }
else {
  $root = Join-Path $here "conflux"
  $got = $false
  if (Get-Command git -ErrorAction SilentlyContinue) {
    # For a private repo, Git Credential Manager opens a GitHub sign-in window.
    git clone --depth 1 $Repo $root
    $got = ($LASTEXITCODE -eq 0) -and (Test-Path (Join-Path $root "package.json"))
  }
  if (-not $got) {
    try {
      $zip = Join-Path $env:TEMP "conflux-main.zip"
      Invoke-WebRequest "$Repo/archive/refs/heads/main.zip" -OutFile $zip
      Expand-Archive $zip -DestinationPath $here -Force
      Rename-Item (Get-ChildItem $here -Directory | Where-Object Name -like "Conflux-main*" | Select-Object -First 1).FullName $root
      $got = $true
    } catch {}
  }
  if (-not $got) {
    throw "Could not download Conflux from $Repo. If the repo is private, install Git for Windows (winget install Git.Git) and sign in when prompted, or put install.ps1 inside an existing Conflux folder and re-run."
  }
}
Set-Location $root
Ok "Using $root"

# ── 3. Dependencies + web UI ───────────────────────────────────────────────
Step "Installing dependencies"
npm install --no-audit --no-fund
if (-not (Test-Path "apps\web\dist\index.html")) {
  Step "Building the web UI"
  npm run build:web
} else { Ok "Web UI already built" }

# ── 4. Desktop control ─────────────────────────────────────────────────────
if (-not $NoDesktop) {
  Step "Installing agent-cu (desktop control through Windows UI Automation)"
  npm install -g agent-cu
}

# ── 5. Browser ─────────────────────────────────────────────────────────────
if (-not $NoBrowser) {
  Step "Installing Chromium for coworker browsers (~150 MB)"
  npx playwright install chromium
}

# ── 6. Launcher ────────────────────────────────────────────────────────────
Step "Creating launchers"
$cmd = Join-Path $root "start-conflux.cmd"
@"
@echo off
cd /d "%~dp0"
if exist .env for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do if not "%%b"=="" set "%%a=%%b"
start "" http://127.0.0.1:8787
node apps\server\src\main.ts
"@ | Set-Content -Encoding ASCII $cmd
if (-not (Test-Path (Join-Path $root ".env"))) { Copy-Item (Join-Path $root ".env.example") (Join-Path $root ".env") }
try {
  $lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Conflux.lnk"
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($lnk); $s.TargetPath = $cmd; $s.WorkingDirectory = $root; $s.Save()
  Ok "Desktop shortcut: $lnk"
} catch { Warn "Could not create a desktop shortcut (start with $cmd)" }

Step "Checking the install"
node bin\conflux.ts doctor

Write-Host "`nConflux is installed." -ForegroundColor Green
Write-Host "  Add an API key (or OLLAMA_HOST=http://localhost:11434) to: $(Join-Path $root '.env')"
Write-Host "  Start any time with the 'Conflux' desktop shortcut or: $cmd"
if (-not $NoStart) {
  Step "Starting Conflux on http://127.0.0.1:8787 (Ctrl+C to stop)"
  & $cmd
}
