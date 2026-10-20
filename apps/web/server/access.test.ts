import { expect, it } from "vitest";
// @ts-expect-error JS server helper
import { requestAccess } from "./access.mjs";
const token = "a-strong-test-token-of-32-characters";
it("keeps local mode local and requires authentication in public mode", () => {
  expect(requestAccess({ headers: { host: "remote.test" } }).status).toBe(403);
  const config = { publicHost: "public.test", accessToken: token };
  expect(requestAccess({ headers: { host: "public.test" } }, config).status).toBe(401);
  expect(requestAccess({ headers: { host: "public.test", authorization: `Basic ${Buffer.from(`glint:${token}`).toString("base64")}` } }, config).status).toBe(200);
  expect(() => requestAccess({ headers: { host: "public.test" } }, { publicHost: "public.test" })).toThrow(/token/);
});
