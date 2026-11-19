import { expect, it } from "vitest";
import { nleInlineJson } from "./nle-render";
import { findSystemBrowser, openCaptureBrowser } from "./direct-browser/host";

const malicious = '</script><script>window.__injected=true</script>\u2028\u2029';
const project = { title: malicious, tracks: [{ name: malicious, clips: [{ text: malicious }] }] };

it("serializes NLE project data without executable closing tags", () => {
  const inline = nleInlineJson(project);
  expect(inline.toLowerCase()).not.toContain("</script");
  expect(JSON.parse(inline)).toEqual(project);
});

let available = false;
try { findSystemBrowser(); available = true; } catch { /* No browser download. */ }
it.skipIf(process.env.GLINT_BROWSER_UI_TEST !== "1" || !available)("keeps untrusted project text inert in a real capture browser", async () => {
  const capture = await openCaptureBrowser(480, 270);
  try {
    await capture.page.setContent(`<!doctype html><script>window.__GLINT_PROJECT=${nleInlineJson(project)};</script>`);
    const observed = await capture.page.evaluate(() => ({
      injected: (window as unknown as { __injected?: boolean }).__injected,
      project: (window as unknown as { __GLINT_PROJECT?: unknown }).__GLINT_PROJECT,
    }));
    expect(observed.injected).toBeUndefined();
    expect(observed.project).toEqual(project);
  } finally { await capture.browser.close(); }
}, 60000);
