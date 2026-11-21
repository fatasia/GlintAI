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
# Get-ChildItem -Recurse reports FullName with the expanded long path (8.3
# short names like RUNNER~1 become runneradmin), while Resolve-Path keeps the
# short form; deriving $relative by Substring($sourceRoot.Length) would then
# slice at the wrong offset and install files to corrupted subpaths. Anchor
# the prefix on Get-Item's FullName so both sides share the same expansion.
$sourceRoot = (Get-Item -LiteralPath $source -Force).FullName.TrimEnd('\', '/')
$targetRoot = $target.TrimEnd('\', '/')
if ($sourceRoot.Equals($targetRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $sourceRoot.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    $targetRoot.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The source and target must be separate directories."
}

foreach ($required in @("Glint.cmd", "Glint.exe", "app\server\service.mjs", "app\cli\glint.mjs")) {
  if (-not (Test-Path (Join-Path $source $required))) {
    throw "The installer source is incomplete: missing $required"
  }
}

Write-Host "Installing Glint to $target"
if (Test-Path $target) {
  $existing = @(Get-ChildItem -LiteralPath $target -Force)
  if ($existing.Count -gt 0 -and
      (-not (Test-Path (Join-Path $target "Glint.cmd")) -or
       -not (Test-Path (Join-Path $target "app\server\service.mjs")))) {
    throw "Target is not an existing Glint installation; choose an empty directory."
  }
} else {
  New-Item -ItemType Directory -Path $target | Out-Null
}
if ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw "Installation target cannot be a link."
}

# Copy program files individually. Never replace the local project/output and
# cache directories; leave other existing files alone instead of deleting them.
$installedFiles = [System.Collections.Generic.List[string]]::new()
foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File -Force) {
  if (-not $file.FullName.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Install source enumeration escaped the source directory: $($file.FullName)"
  }
  $relative = $file.FullName.Substring($sourceRoot.Length).TrimStart('\', '/')
  if ($relative -match '^(\.smoke-data|app[\\/]+studio[\\/]+(out|\.cache))([\\/]|$)') { continue }
  $destination = Join-Path $target $relative
  $parent = Split-Path -Parent $destination
  $cursor = $target
  foreach ($part in ((Split-Path -Parent $relative) -split '[\\/]')) {
    if (-not $part) { continue }
    $cursor = Join-Path $cursor $part
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Installation path contains a link: $cursor"
    }
  }
  if ((Test-Path -LiteralPath $destination) -and ((Get-Item -LiteralPath $destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Installation file is a link: $destination"
  }
  # Skills are user-editable. Keep existing files during upgrades, while still
  # copying newly added Skills and files that do not yet exist.
  if ($relative -match '^skills[\\/]' -and (Test-Path -LiteralPath $destination)) {
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) { throw "Skill destination is not a file: $destination" }
    continue
  }
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
  $installedFiles.Add($relative)
}
# Package archives may omit empty directories; the runtime needs this working
# directory even though its user output must never be copied over on upgrades.
foreach ($relativeDir in @("app", "app\studio", "app\studio\out")) {
  $dir = Join-Path $target $relativeDir
  if ((Test-Path -LiteralPath $dir) -and ((Get-Item -LiteralPath $dir -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Installation directory is a link: $dir"
  }
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
Copy-Item -Path (Join-Path $PSScriptRoot "Uninstall-Glint.ps1") -Destination $target -Force
$installedFiles.Add("Uninstall-Glint.ps1")
ConvertTo-Json -InputObject @($installedFiles.ToArray()) | Set-Content -LiteralPath (Join-Path $target ".glint-installed-files.json") -Encoding UTF8

$shell = New-Object -ComObject WScript.Shell
if (-not $NoShortcuts) {
  $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  $links = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "Glint.lnk"),
    (Join-Path $startMenu "Glint.lnk")
  )
  foreach ($link in $links) {
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = (Join-Path $target "Glint.cmd")
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
