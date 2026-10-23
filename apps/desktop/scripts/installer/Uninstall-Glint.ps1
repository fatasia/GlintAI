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

Write-Host "Removing $target"
# The running script lives inside the target; delete from outside after a short delay.
$cleanup = "Start-Sleep -Milliseconds 600; Remove-Item -LiteralPath '$target' -Recurse -Force -ErrorAction SilentlyContinue"
Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-Command", $cleanup) -WindowStyle Hidden
Write-Host "Glint removed. Session and cache data in $env:APPDATA\ai.glint.desktop.dev are kept; delete that folder for a clean slate."
