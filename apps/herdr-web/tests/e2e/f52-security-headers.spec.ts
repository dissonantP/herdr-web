import { request as httpRequest } from "node:http";
import { expect, test } from "@playwright/test";
import { authed } from "../support/auth.ts";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// Task 052: malformed paths answer 400 (and the server lives on), every response carries the CSP
// and framing headers, and /api GETs refuse other sites and same-site siblings (Sec-Fetch-Site).

const port = () => Number(process.env.HERDR_QA_PORT);
const base = () => `http://127.0.0.1:${String(port())}`;

/** A raw GET with the path as given (fetch would normalise it). */
function rawGet(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: port(), path, headers: authed({}) }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/** A raw WebSocket upgrade with the path as given; its HTTP status, or "upgraded". */
function rawUpgrade(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers = authed({ origin: base(), connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" });
    const req = httpRequest({ host: "127.0.0.1", port: port(), path, headers });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve("upgraded");
    });
    req.on("response", (res) => resolve(String(res.statusCode)));
    req.on("error", reject);
    req.end();
  });
}

test.describe("security hardening", () => {
  test.skip(({ isMobile }) => !isMobile, "no page involved");

  test("@F52 a malformed request path answers 400 and the server stays up", async () => {
    for (const path of ["//", "//[", "//a:b"]) expect(await rawGet(path)).toBe(400);
    expect(await rawUpgrade("//[")).toBe("400");
    expect((await fetch(`${base()}/api/session`, { headers: authed({}) })).status).toBe(204);
  });

  test("@F52 every response carries the CSP and framing headers", async () => {
    for (const path of ["/", "/api/tree", "/manifest.webmanifest", "/sw.js", "/api/nope"]) {
      const res = await fetch(`${base()}${path}`, { headers: authed({}) });
      expect(res.headers.get("content-security-policy"), path).toContain("default-src 'self'");
      expect(res.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
    const login = await fetch(`${base()}/login`);
    expect(login.headers.get("x-frame-options")).toBe("DENY");
    expect(login.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  test("@F52 /api GETs refuse same-site siblings and other sites", async () => {
    const pane = (await seed(qaCore())).terminals.betaA ?? "";
    for (const path of ["/api/tree", "/api/events", `/api/chat/${pane}`]) {
      for (const site of ["same-site", "cross-site"]) {
        expect((await fetch(`${base()}${path}`, { headers: authed({ "sec-fetch-site": site }) })).status, `${path} ${site}`).toBe(403);
      }
    }
    expect((await fetch(`${base()}/api/tree`, { headers: authed({ "sec-fetch-site": "same-origin" }) })).status).toBe(200);
    expect((await fetch(`${base()}/api/tree`, { headers: authed({ "sec-fetch-site": "none" }) })).status).toBe(200);
  });
});

test("@F52 the app runs under its CSP: no violations while the tree, a terminal and the service worker load", async ({ page }) => {
  await seed(qaCore());
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/iu.test(m.text())) violations.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`Refused to load (CSP): ${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto(`/s/${IDS.beta}`);
  await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state ?? "none")).toMatch(/activ/u);
  await page.goto("/");
  await expect(page.getByText("alpha").first()).toBeVisible();
  expect(violations).toEqual([]);
});
