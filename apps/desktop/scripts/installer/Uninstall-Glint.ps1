param(
  [string]$Target = (Join-Path $env:LOCALAPPDATA "Glint"),
  [switch]$NoShortcuts,
  [switch]$NoRegistry
)

$ErrorActionPreference = "Stop"
$target = [System.IO.Path]::GetFullPath($Target)
$shell = New-Object -ComObject WScript.Shell

if (-not $NoShortcuts) {
  $links = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "Glint.lnk"),
    (Join-Path (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs") "Glint.lnk")
  )
  foreach ($link in $links) { if (Test-Path $link) { Remove-Item $link -Force } }
}
if (-not $NoRegistry) {
  Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Glint" -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "Removing installed program files from $target"
$manifest = Join-Path $target ".glint-installed-files.json"
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
  Write-Host "No installation manifest found. Program files were left in place; remove them manually after checking for your projects."
  return
}
if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw "Installation target cannot be a link."
}
$root = $target.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$installedFiles = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
foreach ($relative in $installedFiles) {
  if ($relative -isnot [string] -or $relative -match '^(skills|app[\\/]+studio[\\/]+(out|\.cache))([\\/]|$)') { continue }
  $file = [IO.Path]::GetFullPath((Join-Path $target $relative))
  if (-not $file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { continue }
  $cursor = $target
  $linked = $false
  foreach ($part in ((Split-Path -Parent $relative) -split '[\\/]')) {
    if (-not $part) { continue }
    $cursor = Join-Path $cursor $part
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { $linked = $true; break }
  }
  if ($linked) { continue }
  if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
}
Remove-Item -LiteralPath $manifest -Force
Write-Host "Projects, cache, skills and other files were kept. Session data in $env:APPDATA\ai.glint.desktop.dev was also kept."
