import { expect, it } from "vitest";
import {
  htmlPolicy,
  staticHtmlDocument,
  isolatedHtmlFrame,
} from "./html-policy";
it("denies network, nested frames, workers, forms and external assets", () => {
  const policy = htmlPolicy(["http://localhost:3000/static/gsap.min.js"]);
  for (const directive of [
    "default-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ])
    expect(policy).toContain(directive);
  expect(policy).toContain(
    "script-src 'unsafe-inline' http://localhost:3000/static/gsap.min.js",
  );
  expect(policy).not.toContain("'unsafe-eval'");
  expect(() => htmlPolicy(["javascript:alert(1)"])).toThrow();
});
it("puts navigation restrictions on a dedicated wrapper, not the host document", () => {
  const frame = isolatedHtmlFrame(
    '<script>location.href="https://example.com"</script>',
    "generation",
    true,
    "http://localhost/gsap.min.js",
  );
  expect(frame).toContain("frame-src 'self'");
  expect(frame).toContain('id="glint-document"');
  expect(frame).toContain('srcdoc="&lt;script>');
  expect(frame).toContain("event.source===frame.contentWindow");
});
it("installs the restrictive policy before any user markup", () => {
  const html = staticHtmlDocument(
    '<script>fetch("https://example.com")</script>',
  );
  expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
    html.indexOf("<script>"),
  );
});
