<#
.SYNOPSIS
    Updates all git repositories in the TowerCab 3D mods folder.

.DESCRIPTION
    This script finds all git repositories within the mods directory and
    runs 'git pull' on each to fetch the latest updates.

.EXAMPLE
    .\scripts\update-mods.ps1

    Updates all mod repos in the default mods location.

.EXAMPLE
    .\scripts\update-mods.ps1 -ModsPath "D:\TowerCab\mods"

    Updates all mod repos in a custom mods location.

.NOTES
    Author: TowerCab 3D Team
    Requires: Git installed and available in PATH
#>

param(
    [Parameter(Mandatory=$false)]
    [string]$ModsPath
)

# Determine mods path
if (-not $ModsPath) {
    # Try to find mods folder relative to script location
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $projectRoot = Split-Path -Parent $scriptDir

    # Check common locations
    $possiblePaths = @(
        (Join-Path $projectRoot "src-tauri\resources\mods"),
        (Join-Path $projectRoot "mods"),
        (Join-Path $env:APPDATA "towercab-3d\mods")
    )

    foreach ($path in $possiblePaths) {
        if (Test-Path $path) {
            $ModsPath = $path
            break
        }
    }

    if (-not $ModsPath) {
        Write-Host "Could not find mods directory. Please specify -ModsPath parameter." -ForegroundColor Red
        exit 1
    }
}

Write-Host "TowerCab 3D Mod Updater" -ForegroundColor Cyan
Write-Host "======================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Scanning for git repos in: $ModsPath" -ForegroundColor Gray
Write-Host ""

# Check if mods path exists
if (-not (Test-Path $ModsPath)) {
    Write-Host "Mods directory not found: $ModsPath" -ForegroundColor Red
    exit 1
}

# Find all .git directories (indicating git repos)
$gitRepos = Get-ChildItem -Path $ModsPath -Recurse -Directory -Filter ".git" -ErrorAction SilentlyContinue |
    ForEach-Object { $_.Parent.FullName }

if ($gitRepos.Count -eq 0) {
    Write-Host "No git repositories found in mods folder." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "To add a mod from GitHub:" -ForegroundColor Gray
    Write-Host "  cd `"$ModsPath`"" -ForegroundColor White
    Write-Host "  git clone https://github.com/username/mod-repo.git" -ForegroundColor White
    exit 0
}

Write-Host "Found $($gitRepos.Count) git repository(ies):" -ForegroundColor Green
Write-Host ""

$updated = 0
$failed = 0
$upToDate = 0

foreach ($repo in $gitRepos) {
    $repoName = Split-Path -Leaf $repo
    Write-Host "  Updating: $repoName" -ForegroundColor White -NoNewline

    try {
        Push-Location $repo

        # Fetch first to get remote state
        $fetchOutput = git fetch 2>&1

        # Check if there are updates
        $localCommit = git rev-parse HEAD 2>&1
        $remoteCommit = git rev-parse "@{u}" 2>&1

        if ($localCommit -eq $remoteCommit) {
            Write-Host " - up to date" -ForegroundColor DarkGray
            $upToDate++
        } else {
            # Pull updates
            $pullOutput = git pull 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host " - updated!" -ForegroundColor Green
                $updated++
            } else {
                Write-Host " - FAILED" -ForegroundColor Red
                Write-Host "    $pullOutput" -ForegroundColor Red
                $failed++
            }
        }
    } catch {
        Write-Host " - ERROR" -ForegroundColor Red
        Write-Host "    $_" -ForegroundColor Red
        $failed++
    } finally {
        Pop-Location
    }
}

Write-Host ""
Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "  Updated:    $updated" -ForegroundColor Green
Write-Host "  Up to date: $upToDate" -ForegroundColor Gray
if ($failed -gt 0) {
    Write-Host "  Failed:     $failed" -ForegroundColor Red
}
Write-Host ""

if ($updated -gt 0) {
    Write-Host "Restart TowerCab 3D to load the updated mods." -ForegroundColor Yellow
}
