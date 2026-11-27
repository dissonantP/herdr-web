import { expect, test, type Locator, type Page } from "@playwright/test";
import { addTab, claudeProgram, IDS, seed, type Seeded } from "../support/fixture.ts";
import { authed } from "../support/auth.ts";
import { qaCore } from "../support/world.ts";

// F39: the node graph of the space hierarchy, switchable with the list: top-down with the top-level spaces at
// the top, each node with its name and status, a sessions toggle (off by default), tap to open
// (a panel beside the graph on desktop, full screen on the phone), and drag a node onto another to
// re-parent it (a cycle is refused). Dragging runs as touch on the phone project.

const base = () => `http://127.0.0.1:${String(process.env.HERDR_QA_PORT)}`;

async function act(action: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${base()}/api/actions`, { method: "POST", headers: authed({ "content-type": "application/json", origin: base() }), body: JSON.stringify(action) });
  return (await res.json()) as { ok: boolean; error?: string };
}

/** The groups file as the QA core has it (herdr's own writes land there). */
async function qaGroups(): Promise<{ spaces: Record<string, unknown> }> {
  return qaCore().readGroups() as { spaces: Record<string, unknown> };
}

const node = (page: Page, id: string): Locator => page.locator(`[data-testid="graph-node"][data-kind="space"][data-id="${id}"]`);

async function graph(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("tree-space").first()).toBeVisible();
  await page.getByTestId("view-graph").click();
  await expect(page.getByTestId("graph-view")).toBeVisible();
  await expect(node(page, IDS.beta)).toBeVisible();
}

async function parents(): Promise<Record<string, string | null>> {
  const doc = (await qaCore().call("doc.get", { name: "herdr-tree" })).value as { spaces: Record<string, { parent: string | null }> } | null;
  return Object.fromEntries(Object.entries(doc?.spaces ?? {}).map(([id, e]) => [id, e.parent]));
}

/** Drag the centre of one node to the centre of another: touch on the phone, the mouse on desktop. */
async function drag(page: Page, from: Locator, to: Locator, touch: boolean): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (a === null || b === null) throw new Error("node not visible");
  const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const end = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const steps = 12;
  const at = (i: number) => ({ x: start.x + ((end.x - start.x) * i) / steps, y: start.y + ((end.y - start.y) * i) / steps });
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    for (let i = 1; i <= steps; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at(i)] });
    // The node trails the finger a little; like a person watching it, nudge the finger until the node's centre is on the target.
    let finger = end;
    for (let round = 0; round < 3; round++) {
      await page.waitForTimeout(150);
      const box = await from.boundingBox();
      if (box === null) break;
      finger = { x: finger.x + end.x - (box.x + box.width / 2), y: finger.y + end.y - (box.y + box.height / 2) };
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [finger] });
    }
    await page.waitForTimeout(150);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(at(i).x, at(i).y);
    await page.mouse.up();
  }
}

test.describe.skip("@F39 node graph", () => {
  let seeded: Seeded;
  test.beforeEach(async () => {
    seeded = await seed(qaCore());
    expect((await act({ type: "space.reparent", id: IDS.gamma, parentId: IDS.beta })).ok).toBe(true);
  });

  test("switches with the list; parents sit above their children; each node shows its status", async ({ page }) => {
    const core = qaCore();
    await addTab(core, seeded, "alpha", "needy", claudeProgram("blocked"));
    await addTab(core, seeded, "delta", "busy", claudeProgram("working"));
    await graph(page);
    const y = async (id: string) => (await node(page, id).boundingBox())?.y ?? NaN;
    expect(await y(IDS.beta)).toBeLessThan(await y(IDS.gamma));
    await expect(node(page, IDS.alpha)).toHaveAttribute("data-status", "waiting");
    await expect(node(page, IDS.alpha)).toContainText("needs input");
    await expect(node(page, IDS.delta)).toHaveAttribute("data-status", "working");
    // Back to the list and again.
    await page.getByTestId("view-list").click();
    await expect(page.getByTestId("tree-space").first()).toBeVisible();
    await expect(page.getByTestId("graph-view")).toHaveCount(0);
  });

  test("sessions show as small child nodes only when toggled on", async ({ page }) => {
    await graph(page);
    await expect(page.locator('[data-testid="graph-node"][data-kind="session"]')).toHaveCount(0);
    await page.getByTestId("graph-sessions").check();
    await expect(page.locator('[data-testid="graph-node"][data-kind="session"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="graph-node"][data-kind="session"]').filter({ hasText: "beta-a" })).toHaveCount(1);
  });

  test("tapping a node opens the space: a panel beside the graph on desktop, full screen on the phone", async ({ page }, info) => {
    await graph(page);
    await node(page, IDS.beta).click();
    await expect(page.getByTestId("space-view")).toBeVisible();
    if (info.project.name === "phone") {
      await expect(page.getByTestId("graph-view")).toHaveCount(0);
      await page.getByRole("button", { name: "Back to spaces" }).click();
      await expect(page.getByTestId("graph-view")).toBeVisible();
      await expect(page.getByTestId("space-view")).toHaveCount(0);
    } else {
      await expect(page.getByTestId("graph-view")).toBeVisible();
      await expect(page.getByTestId("graph-panel").getByTestId("space-view")).toBeVisible();
    }
  });

  test("dragging a node onto another re-parents it; dropping onto its own child is refused", async ({ page }, info) => {
    const touch = info.project.name === "phone";
    await graph(page);
    await drag(page, node(page, IDS.alpha), node(page, IDS.delta), touch);
    await expect.poll(parents).toMatchObject({ [IDS.alpha]: IDS.delta });
    // Wait for the graph to redraw (and reframe) under the new parent before the next drag.
    await expect.poll(async () => ((await node(page, IDS.alpha).boundingBox())?.y ?? 0) > ((await node(page, IDS.delta).boundingBox())?.y ?? 0)).toBe(true);
    await page.waitForTimeout(400);
    // beta onto its own child gamma: refused, nothing changed.
    await expect(node(page, IDS.gamma)).toBeVisible();
    await drag(page, node(page, IDS.beta), node(page, IDS.gamma), touch);
    await expect(page.getByTestId("graph-note")).toContainText(/inside/u);
    expect((await parents())[IDS.beta] ?? null).toBeNull();
  });

  test("groups are labelled boxes around their spaces, nested to any depth", async ({ page }) => {
    await graph(page);
    const group = (id: string) => page.locator(`[data-testid="graph-node"][data-kind="group"][data-id="${id}"]`);
    const rect = async (l: Locator) => (await l.boundingBox()) ?? { x: NaN, y: NaN, width: NaN, height: NaN };
    const inside = async (inner: Locator, outer: Locator) => {
      const a = await rect(inner);
      const b = await rect(outer);
      return a.x >= b.x - 1 && a.y >= b.y - 1 && a.x + a.width <= b.x + b.width + 1 && a.y + a.height <= b.y + b.height + 1;
    };
    await expect(group(IDS.work)).toContainText("work");
    await expect(group(IDS.inner)).toBeVisible();
    // work > inner > alpha; beta stays ungrouped, and gamma (nested under it) sits in a box around beta's subtree.
    await expect(page.locator(`[data-testid="graph-subtree"][data-id="${IDS.beta}"]`)).toBeVisible();
    expect(await inside(node(page, IDS.gamma), page.locator(`[data-testid="graph-subtree"][data-id="${IDS.beta}"]`))).toBe(true);
    expect(await inside(group(IDS.inner), group(IDS.work))).toBe(true);
    expect(await inside(node(page, IDS.alpha), group(IDS.inner))).toBe(true);
    expect(await inside(node(page, IDS.beta), group(IDS.work))).toBe(false);
    await page.screenshot({ path: test.info().outputPath("graph-groups.png") });
    // Tapping a group does nothing; it is not a place.
    await group(IDS.work).locator(".gbox-label").click();
    await expect(page.getByTestId("space-view")).toHaveCount(0);
  });

  test("dragging a space onto a group moves it into that group, even a nested space", async ({ page }, info) => {
    const touch = info.project.name === "phone";
    await graph(page);
    const group = (id: string) => page.locator(`[data-testid="graph-node"][data-kind="group"][data-id="${id}"]`);
    const groupOf = async (id: string) => ((await qaGroups()).spaces[id] as { groupId: string | null } | undefined)?.groupId ?? null;
    await drag(page, node(page, IDS.delta), group(IDS.work).locator(".gbox-label"), touch);
    await expect.poll(() => groupOf(IDS.delta)).toBe(IDS.work);
    await page.waitForTimeout(500);
    // gamma is nested under beta in this world: dropping it on a group lifts it out of beta first.
    await drag(page, node(page, IDS.gamma), group(IDS.empty).locator(".gbox-label"), touch);
    await expect.poll(() => groupOf(IDS.gamma)).toBe(IDS.empty);
    expect((await parents())[IDS.gamma] ?? null).toBeNull();
  });

  test("dropping a space in a nested group's box puts it in the innermost group, not the outer one", async ({ page }, info) => {
    const touch = info.project.name === "phone";
    await graph(page);
    const label = page.locator(`[data-testid="graph-node"][data-kind="group"][data-id="${IDS.inner}"] .gbox-label`);
    const groupOf = async (id: string) => ((await qaGroups()).spaces[id] as { groupId: string | null } | undefined)?.groupId ?? null;
    await drag(page, node(page, IDS.delta), label, touch);
    await expect.poll(() => groupOf(IDS.delta)).toBe(IDS.inner);
  });

  test("long names are never cut off: the title wraps and the status sits on a second line", async ({ page }) => {
    const long = "A very long space name that goes on and on and on, then Supercalifragilisticexpialidocious_unbroken_word";
    expect((await act({ type: "space.rename", id: IDS.beta, name: long })).ok).toBe(true);
    expect((await act({ type: "group.rename", id: IDS.work, name: "A group named with a really long title for wrapping" })).ok).toBe(true);
    await graph(page);
    await page.getByTestId("graph-sessions").check();
    const target = node(page, IDS.beta);
    await expect(target).toContainText("Supercalifragilistic");
    await page.screenshot({ path: test.info().outputPath("graph-long-names.png") });
    // Nothing overflows its node: every node's content fits inside it, and the status is below the title.
    const overflowing = await page.locator('[data-testid="graph-node"]').evaluateAll((els) =>
      els.filter((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1 || (el.firstElementChild as HTMLElement | null) === null).map((el) => el.textContent),
    );
    expect(overflowing).toEqual([]);
    // Sizes in the node's own pixels (the canvas may be zoomed): wrapped onto several lines, status below the title, all inside the node.
    const m = await target.evaluate((el) => {
      const title = el.querySelector<HTMLElement>(".gnode-title");
      const status = el.querySelector<HTMLElement>(".gnode-status");
      return { titleH: title?.offsetHeight ?? 0, titleBottom: (title?.offsetTop ?? 0) + (title?.offsetHeight ?? 0), statusTop: status?.offsetTop ?? 0, statusBottom: (status?.offsetTop ?? 0) + (status?.offsetHeight ?? 0), h: (el as HTMLElement).offsetHeight };
    });
    expect(m.titleH).toBeGreaterThan(60);
    expect(m.statusTop).toBeGreaterThanOrEqual(m.titleBottom);
    expect(m.statusBottom).toBeLessThanOrEqual(m.h);
  });

  test("the List | Graph control shows both options with the current one highlighted", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("tree-space").first()).toBeVisible();
    await expect(page.getByTestId("view-list")).toHaveText("List");
    await expect(page.getByTestId("view-graph")).toHaveText("Graph");
    await expect(page.getByTestId("view-list")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("view-graph")).toHaveAttribute("aria-selected", "false");
    await page.screenshot({ path: test.info().outputPath("list-toggle.png") });
    await page.getByTestId("view-graph").click();
    await expect(page.getByTestId("view-graph")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("view-list")).toHaveAttribute("aria-selected", "false");
    await expect(page.getByTestId("view-list")).toBeVisible();
  });
});
