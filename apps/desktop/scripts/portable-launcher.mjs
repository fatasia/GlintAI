export function chapterLauncher({ lite }) {
  return [
    "@echo off", "chcp 65001 >nul",
    lite ? 'set "CHAPTER_NODE=node"' : 'set "CHAPTER_NODE=%~dp0node.exe"',
    '"%CHAPTER_NODE%" "%~dp0app\\cli\\local-chapter-tool.mjs" %*',
    'exit /b %errorlevel%', "",
  ].join("\r\n");
}

/** Resolve all executable and data paths at the unpacked package location. */
export function portableLauncher({ lite, buildId }) {
  const variables = {
    GLINT_BUILD_FILE: "%~dp0app\\build.json",
    GLINT_DESKTOP_REPO: "%~dp0app",
    GLINT_DESKTOP_SERVICE: "%~dp0app\\server\\service.mjs",
    GLINT_WEB_DIST: "%~dp0app\\web",
    GLINT_STUDIO_DIR: "%~dp0app\\studio",
    GLINT_MAKE_ENTRY: "%~dp0app\\cli\\glint.mjs",
    GLINT_CLI_ENTRY: "%~dp0app\\cli\\glint.mjs",
    GLINT_PREBUILT_BUNDLE: "%~dp0app\\remotion-bundle",
    GLINT_NLE_HARNESS: "%~dp0app\\cli\\nle-harness.js",
    GLINT_DIRECT_BROWSER_HARNESS: "%~dp0app\\cli\\direct-browser.js",
    GLINT_RUNTIME_ASSETS: "%~dp0app\\runtime-assets",
    GLINT_BUILD_ID: buildId,
  };
  return [
    "@echo off",
    lite ? "rem Lite build: uses system Node.js 22+." : "rem Full build: uses the bundled Node runtime.",
    ...(lite ? [
      'set "GLINT_DESKTOP_NODE="',
      'for /f "delims=" %%i in (\'where node 2^>nul\') do if not defined GLINT_DESKTOP_NODE set "GLINT_DESKTOP_NODE=%%i"',
      'if not defined GLINT_DESKTOP_NODE (echo Node.js 22+ is required for the lite build. Install Node or use the full build. & exit /b 1)',
      '"%GLINT_DESKTOP_NODE%" -e "if (Math.sign(Number(process.versions.node.split(\'.\')[0])-22)===-1) process.exit(1)" >nul 2>nul',
      'if errorlevel 1 (echo Node.js 22+ is required for the lite build. Install Node or use the full build. & exit /b 1)',
    ] : ['set "GLINT_DESKTOP_NODE=%~dp0node.exe"']),
    'set "GLINT_MAKE_NODE=%GLINT_DESKTOP_NODE%"',
    ...Object.entries(variables).map(([key, value]) => `set "${key}=${value}"`),
    'start "" "%~dp0Glint.exe"',
    "",
  ].join("\r\n");
}
