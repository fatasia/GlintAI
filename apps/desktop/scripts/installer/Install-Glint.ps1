param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$Target = (Join-Path $env:LOCALAPPDATA "Glint"),
  [switch]$NoShortcuts,
  [switch]$NoRegistry,
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$source = (Resolve-Path $Source).Path
$target = [System.IO.Path]::GetFullPath($Target)

foreach ($required in @("Glint.cmd", "Glint.exe", "app\server\service.mjs", "app\cli\glint.mjs")) {
  if (-not (Test-Path (Join-Path $source $required))) {
    throw "The installer source is incomplete: missing $required"
  }
}

Write-Host "Installing Glint to $target"
if (Test-Path $target) {
  # Replacing program files only; sessions/cache live outside this folder.
  Get-ChildItem $target -Force | Remove-Item -Recurse -Force
} else {
  New-Item -ItemType Directory -Path $target | Out-Null
}

Copy-Item -Path (Join-Path $source "*") -Destination $target -Recurse -Force
Copy-Item -Path (Join-Path $PSScriptRoot "Uninstall-Glint.ps1") -Destination $target -Force

$shell = New-Object -ComObject WScript.Shell
if (-not $NoShortcuts) {
  $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  $links = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "Glint.lnk"),
    (Join-Path $startMenu "Glint.lnk")
  )
  foreach ($link in $links) {
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = (Join-Path $target "Glint.exe")
    $shortcut.Arguments = ""
    $shortcut.WorkingDirectory = $target
    $shortcut.IconLocation = (Join-Path $target "Glint.exe")
    $shortcut.Description = "Glint - local video workbench"
    $shortcut.Save()
  }
  Write-Host "Created desktop and Start Menu shortcuts"
}

if (-not $NoRegistry) {
  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Glint"
  New-Item -Path $key -Force | Out-Null
  $size = (Get-ChildItem $target -Recurse -File | Measure-Object Length -Sum).Sum
  $entry = @{
    DisplayName = "Glint"
    DisplayVersion = (Get-Content (Join-Path $target "app\build.json") -ErrorAction SilentlyContinue | ConvertFrom-Json).version
    Publisher = "Glint"
    DisplayIcon = (Join-Path $target "Glint.exe")
    InstallLocation = $target
    EstimatedSize = [int]($size / 1KB)
    NoModify = 1
    NoRepair = 1
    UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $target 'Uninstall-Glint.ps1')`""
  }
  foreach ($name in $entry.Keys) { Set-ItemProperty -Path $key -Name $name -Value $entry[$name] }
  Write-Host "Registered uninstall entry (per-user)"
}

Write-Host "Installed. Launch: $target\Glint.cmd"
if (-not $NoLaunch) { Start-Process -FilePath (Join-Path $target "Glint.cmd") -WorkingDirectory $target }
