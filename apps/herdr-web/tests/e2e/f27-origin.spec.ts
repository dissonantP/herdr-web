import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import { authed } from "../support/auth.ts";
import { seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F27: every non-GET request needs Origin == Host; WebSocket upgrades need it too, and a missing
// Origin is refused. No page involved, so it runs once (the phone project).

test.skip(({ isMobile }) => !isMobile, "no page involved");

const base = () => `http://127.0.0.1:${String(process.env.HERDR_QA_PORT)}`;
const action = JSON.stringify({ type: "group.create", name: "origin-test", parentId: null });

function post(headers: Record<string, string>, method = "POST", path = "/api/actions") {
  return fetch(`${base()}${path}`, { method, headers: authed({ "content-type": "application/json", ...headers }), body: action });
}

function upgrade(pane: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(process.env.HERDR_QA_PORT)}/api/terminal/${pane}`, { headers: authed(headers) });
    ws.on("open", () => {
      ws.close();
      resolve("open");
    });
    ws.on("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
    ws.on("error", () => resolve("error"));
  });
}

test("@F27 non-GET requests and WebSocket upgrades need Origin == Host", async () => {
  const core = qaCore();
  const seeded = await seed(core);
  // fetch() in Node sends no Origin unless told to.
  expect((await post({})).status).toBe(403);
  expect((await post({ origin: "https://evil.example" })).status).toBe(403);
  expect((await post({ origin: "null" })).status).toBe(403);
  expect((await post({}, "DELETE", "/api/tree")).status).toBe(403);
  expect((await post({}, "PUT", "/anything")).status).toBe(403);
  expect(core.readGroups().groups.some((g) => g.name === "origin-test")).toBe(false);
  const ok = await post({ origin: base() });
  expect(ok.status).toBe(200);
  expect(core.readGroups().groups.some((g) => g.name === "origin-test")).toBe(true);

  const pane = seeded.terminals.betaA ?? "";
  expect(await upgrade(pane, {})).toBe("403");
  expect(await upgrade(pane, { origin: "https://evil.example" })).toBe("403");
  expect(await upgrade(pane, { origin: base() })).toBe("open");
});
