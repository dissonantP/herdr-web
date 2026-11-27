import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { APP_CSP, fetchSiteAllowed } from "./headers.ts";

const req = (site?: string) => ({ headers: site === undefined ? {} : { "sec-fetch-site": site } }) as unknown as IncomingMessage;

describe("security headers (task 052)", () => {
  it("lets the app's own pages and typed URLs read /api, not other sites or same-site siblings", () => {
    expect(fetchSiteAllowed(req("same-origin"))).toBe(true);
    expect(fetchSiteAllowed(req("none"))).toBe(true);
    expect(fetchSiteAllowed(req())).toBe(true);
    expect(fetchSiteAllowed(req("same-site"))).toBe(false);
    expect(fetchSiteAllowed(req("cross-site"))).toBe(false);
  });

  it("has a CSP that keeps to this origin and cannot be framed", () => {
    expect(APP_CSP).toContain("default-src 'self'");
    expect(APP_CSP).toContain("frame-ancestors 'none'");
    expect(APP_CSP).toContain("img-src 'self' data:");
    expect(APP_CSP).toMatch(/connect-src 'self' data:(;|$)/u);
  });
});
