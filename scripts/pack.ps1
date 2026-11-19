# Build a clean delivery archive: source only, no node_modules, no .env, no databases, no session logs.
# Usage: powershell -File scripts/pack.ps1 [-Version 0.1.0] [-OutDir dist]
param(
  [string]$Version = (Get-Content (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json).version,
  [string]$OutDir = 'dist'
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$out = Join-Path $root $OutDir
New-Item -ItemType Directory -Force -Path $out | Out-Null
$archive = Join-Path $out ("erstantwort-intl-{0}.zip" -f $Version)
if (Test-Path $archive) { Remove-Item $archive -Force }

$staging = Join-Path $env:TEMP ("erstantwort-pack-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $staging | Out-Null

$skipDirs = @('node_modules', 'var', '.git', 'dist', 'reports', 'coverage', '.n8n', 'uploads', 'agent-tools', '__pycache__', '.cursor')
$skipFiles = @('.env', '.env.local', '.DS_Store')
$skipPatterns = @('dsh-session-*.zip', 'dsh-session-*.jsonl', '*.sqlite', '*.sqlite-shm', '*.sqlite-wal', '*.log', '*.tap', '*.pyc', '*.zip')

Get-ChildItem -LiteralPath $root -Force | ForEach-Object {
  if ($_.PSIsContainer -and $skipDirs -contains $_.Name) { return }
  if (-not $_.PSIsContainer) {
    if ($skipFiles -contains $_.Name) { return }
    foreach ($pattern in $skipPatterns) { if ($_.Name -like $pattern) { return } }
  }
  Copy-Item -LiteralPath $_.FullName -Destination $staging -Recurse -Force
}

Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $archive -CompressionLevel Optimal
Remove-Item -LiteralPath $staging -Recurse -Force

$size = [math]::Round((Get-Item $archive).Length / 1MB, 2)
Write-Output ("packed {0} ({1} MB)" -f $archive, $size)
