import { expect, test } from "@playwright/test";
import type { GroupNode, SpaceNode, Tree } from "../../src/shared/model.ts";

// Task 56: the graph is compact (a realistic tree fits the pane at a readable zoom, wide fan-outs
// wrap into a grid) and draws groups and subtrees as nested boxes. The tree is served by a stub of
// the event stream so the size matches a real, busy one (~30 spaces, 7 groups).

const space = (id: string, children: SpaceNode[] = [], status: "idle" | "working" | "waiting" | null = "idle"): SpaceNode => ({
  id,
  name: id,
  quiet: false,
  color: null,
  tabs: status === null ? [] : [{ id: `t-${id}`, name: "1", panes: [{ id: `p-${id}`, kind: "terminal", name: `${id}-claude`, agent: "claude", status, chat: true, asleep: false }] }],
  children,
});
const group = (id: string, name: string, spaces: SpaceNode[], groups: GroupNode[] = []): GroupNode => ({ id, name, color: null, spaces, groups });
const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => space(`${prefix}-${String(i + 1)}`, [], i % 5 === 0 ? "working" : i % 7 === 0 ? "waiting" : "idle"));

const tree: Tree = {
  spaces: [
    space("root", [space("herdr", [space("herdr-build-1", [], "working"), space("herdr-build-2"), space("herdr-qa")]), space("dagu-jobs"), space("printer")], "idle"),
    space("scratch"),
    space("notes-and-a-longer-title"),
  ],
  groups: [
    group("g-work", "work", many("work", 5), [group("g-client", "client projects", many("client", 4)), group("g-infra", "infrastructure and servers", many("infra", 3))]),
    group("g-music", "music", [space("clyphx", many("clyphx-sub", 4)), ...many("ableton", 2)]),
    group("g-personal", "personal", many("life", 3)),
    group("g-games", "games", many("game", 2)),
    group("g-empty", "empty", []),
    group("g-archive", "archive", many("old", 3)),
  ],
};

test.beforeEach(async ({ page }) => {
  test.skip(true, "graph view parked (task 057)");
  await page.route("**/api/events", (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: `data: ${JSON.stringify({ ok: true, tree })}\n\n` }));
  await page.goto("/");
  await page.getByTestId("view-graph").click();
  await expect(page.getByTestId("graph-view")).toBeVisible();
  await page.waitForTimeout(600);
});

test.skip("@F56 a realistic tree fits the pane at a readable zoom and groups are nested boxes", async ({ page }) => {
  await page.screenshot({ path: test.info().outputPath("graph-compact.png") });
  const box = page.locator(".graph-canvas");
  const canvas = (await box.boundingBox())!;
  const nodes = await page.locator('[data-testid="graph-node"][data-kind="space"]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number }));
  expect(nodes.length).toBeGreaterThanOrEqual(30);
  // Everything is inside the viewport at the initial view, and a space node is still wide enough to read.
  for (const n of nodes) {
    expect(n.x).toBeGreaterThanOrEqual(canvas.x - 1);
    expect(n.x + n.width).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
    expect(n.y).toBeGreaterThanOrEqual(canvas.y - 1);
    expect(n.y + n.height).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
  }
  expect(Math.min(...nodes.map((n) => n.width))).toBeGreaterThan(70);
  // A nested group's box sits inside its parent's box, and a group's spaces inside its box.
  const rect = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
  const outer = await rect('[data-kind="group"][data-id="g-work"]');
  const inner = await rect('[data-kind="group"][data-id="g-client"]');
  const leaf = await rect('[data-kind="space"][data-id="client-1"]');
  const within = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
  expect(within(inner, outer)).toBe(true);
  expect(within(leaf, inner)).toBe(true);
  // A space with child spaces has its own box around the subtree.
  expect(within(await rect('[data-kind="space"][data-id="herdr-qa"]'), await rect('[data-testid="graph-subtree"][data-id="herdr"]'))).toBe(true);
});

test.skip("@F56 with sessions shown, nodes still don't overlap", async ({ page }) => {
  await page.getByTestId("graph-sessions").check();
  await page.waitForTimeout(600);
  await page.screenshot({ path: test.info().outputPath("graph-compact-sessions.png") });
  const rects = await page.locator('[data-testid="graph-node"]:not([data-kind="group"])').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as { x: number; y: number; right: number; bottom: number }));
  expect(rects.length).toBeGreaterThan(60);
  for (const [i, a] of rects.entries()) {
    for (const b of rects.slice(i + 1)) expect(a.right <= b.x + 0.5 || b.right <= a.x + 0.5 || a.bottom <= b.y + 0.5 || b.bottom <= a.y + 0.5).toBe(true);
  }
});
