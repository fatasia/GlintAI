import { describe, expect, it } from "vitest";
import { browserCandidates, findSystemBrowser } from "./host";

describe("capture browser discovery", () => {
  it("prefers an explicit path and includes Chrome plus Edge on Windows", () => {
    const candidates = browserCandidates({ GLINT_CHROME_PATH: "D:/tools/edge.exe", PROGRAMFILES: "C:/PF", "PROGRAMFILES(X86)": "C:/PF86", LOCALAPPDATA: "C:/LA" } as NodeJS.ProcessEnv, "win32");
    expect(candidates[0]).toBe("D:/tools/edge.exe");
    expect(candidates).toContain("C:/PF/Google/Chrome/Application/chrome.exe");
    expect(candidates).toContain("C:/LA/Google/Chrome/Application/chrome.exe");
    expect(candidates).toContain("C:/PF/Microsoft/Edge/Application/msedge.exe");
    expect(candidates).toContain("C:/PF86/Microsoft/Edge/Application/msedge.exe");
  });
  it("uses platform-specific fallbacks for macOS and Linux", () => {
    expect(browserCandidates({}, "darwin")).toContain("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    expect(browserCandidates({}, "linux")).toContain("/usr/bin/microsoft-edge");
    expect(browserCandidates({}, "linux").every(file => !file.includes("C:/"))).toBe(true);
  });
  it("returns the first existing candidate and reports every checked path when none exist", () => {
    const exists = (file: string) => file === "C:/PF/Microsoft/Edge/Application/msedge.exe";
    expect(findSystemBrowser({ PROGRAMFILES: "C:/PF" } as NodeJS.ProcessEnv, "win32", exists)).toBe("C:/PF/Microsoft/Edge/Application/msedge.exe");
    expect(() => findSystemBrowser({ GLINT_CHROME_PATH: "D:/missing.exe" } as NodeJS.ProcessEnv, "win32", () => false)).toThrow(/Checked: .*missing\.exe/);
    expect(() => findSystemBrowser({} as NodeJS.ProcessEnv, "linux", () => false)).toThrow(/set GLINT_CHROME_PATH/);
  });
});
