import { expect, test, type Page } from "@playwright/test";
import { dialog, home, row, rowAction, submitDialog, unfoldAll } from "../support/admin-ui.ts";
import { authed } from "../support/auth.ts";
import { IDS, seed, type Seeded } from "../support/fixture.ts";
import type { QaCore } from "../support/qa-core.ts";
import { qaCore } from "../support/world.ts";

// F23: spaces nest to any depth through `herdr-tree`; a space made by a session in space A appears
// under A by itself; a space moves to another parent or the top; a cycle is refused; a nested node
// opens on a tap; deleting a parent asks whether its children move up or go with it.

const KID = "spk1k1k1k1k1k1k1k1k1k1k1k1k1k1k1k1";
const GRAND = "spg2g2g2g2g2g2g2g2g2g2g2g2g2g2g2g2";
const base = () => `http://127.0.0.1:${String(process.env.HERDR_QA_PORT)}`;

/** A space Desktop adopts from a terminal that `parent` (a terminal) started, as an agent's `hc run` does. */
async function spaceFrom(core: QaCore, seeded: Seeded, id: string, name: string, parent: string): Promise<string> {
  const tabId = `tb${id.slice(2)}`;
  const result = await core.call("terminal.run", { argv: ["sleep", "3600"], name: `${name}-shell`, parent, no_notify: true, labels: { "herdr.space": id, "herdr.tab": tabId, where: `${name} / 1` } });
  const address = String(result.address);
  seeded.layout.spaces.push({ id, name, folder: "/tmp", tabs: [{ id: tabId, name: "", root: { type: "row", id: tabId, children: [{ type: "block", id: `pa${address}`, content: { terminal: address } }] } }] });
  await core.setLayout(seeded.layout);
  return address;
}

async function act(action: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${base()}/api/actions`, { method: "POST", headers: authed({ "content-type": "application/json", origin: base() }), body: JSON.stringify(action) });
  return (await res.json()) as { ok: boolean; error?: string };
}

async function parents(core: QaCore): Promise<Record<string, string | null>> {
  const doc = (await core.call("doc.get", { name: "herdr-tree" })).value as { spaces: Record<string, { parent: string | null }> } | null;
  return Object.fromEntries(Object.entries(doc?.spaces ?? {}).map(([id, e]) => [id, e.parent]));
}

/** The space row `child` drawn inside the subtree of the space row `parent`. */
const inside = (page: Page, parent: string, child: string) => page.locator(`div:has(> [data-testid="tree-space"][data-id="${parent}"]) [data-testid="tree-space"][data-id="${child}"]`);

test.describe("@F23 nested spaces", () => {
  let seeded: Seeded;
  test.beforeEach(async () => {
    seeded = await seed(qaCore());
  });

  test("a space made by a session appears under that session's space, to any depth; a tap opens it", async ({ page }) => {
    const core = qaCore();
    await home(page);
    const kidShell = await spaceFrom(core, seeded, KID, "kid", seeded.terminals.betaA ?? "");
    await spaceFrom(core, seeded, GRAND, "grand", kidShell);
    await expect.poll(() => parents(core)).toMatchObject({ [KID]: IDS.beta, [GRAND]: KID });
    await unfoldAll(page);
    await expect(inside(page, IDS.beta, KID)).toHaveAttribute("data-depth", "1");
    await expect(inside(page, KID, GRAND)).toHaveAttribute("data-depth", "2");
    // Never drawn at the top or as a tab.
    await expect(row(page, "space", KID)).toHaveCount(1);
    await row(page, "space", GRAND).locator(".row-name").click();
    await expect(page.getByTestId("space-view")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Tabs" }).getByRole("tab")).toHaveText(["1"]);
    await expect(page.getByTestId("pane-view").locator(".pane-title")).toHaveText("grand-shell");
  });

  test("move a space to another parent and back to the top; a cycle is refused", async ({ page }) => {
    const core = qaCore();
    await home(page);
    // gamma sits in group work; nested in beta, its group no longer applies.
    await rowAction(row(page, "space", IDS.gamma), "Move to space…");
    await submitDialog(page, { Inside: IDS.beta }, "Move");
    await unfoldAll(page);
    await expect(inside(page, IDS.beta, IDS.gamma)).toHaveAttribute("data-depth", "1");
    expect((await parents(core))[IDS.gamma]).toBe(IDS.beta);
    // A nested space has no group to move to.
    await row(page, "space", IDS.gamma).getByTestId("row-actions").click();
    await expect(page.getByRole("menuitem", { name: "Move to group…" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // beta into gamma, its own child: refused, and nothing changed.
    const refused = await act({ type: "space.reparent", id: IDS.beta, parentId: IDS.gamma });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/inside its own/u);
    expect((await parents(core))[IDS.beta]).toBeNull();
    // The dialog does not even offer it.
    await rowAction(row(page, "space", IDS.beta), "Move to space…");
    await expect(dialog(page).getByLabel("Inside").locator(`option[value="${IDS.gamma}"]`)).toHaveCount(0);
    await dialog(page).getByRole("button", { name: "Cancel" }).click();

    await rowAction(row(page, "space", IDS.gamma), "Move to space…");
    await submitDialog(page, { Inside: "" }, "Move");
    // Back at the top, in its group again (the groups file was never touched).
    await expect(page.locator(`.group:has([data-testid="tree-group"][data-id="${IDS.work}"]) [data-testid="tree-space"][data-id="${IDS.gamma}"]`)).toHaveAttribute("data-depth", "1");
    expect(core.readGroups().spaces[IDS.gamma]?.groupId).toBe(IDS.work);
    expect((await parents(core))[IDS.gamma]).toBeNull();
  });

  test("deleting a parent asks: move its children up a level, or delete the whole subtree", async ({ page }) => {
    const core = qaCore();
    expect((await act({ type: "space.reparent", id: IDS.delta, parentId: IDS.beta })).ok).toBe(true);
    expect((await act({ type: "space.reparent", id: IDS.alpha, parentId: IDS.delta })).ok).toBe(true);
    await home(page);
    await rowAction(row(page, "space", IDS.beta), "Delete…");
    await expect(dialog(page)).toContainText("It holds 2 spaces");
    await dialog(page).getByRole("button", { name: "Move them up, end 3" }).click();
    await expect(row(page, "space", IDS.beta)).toHaveCount(0);
    await expect(row(page, "space", IDS.delta)).toHaveAttribute("data-depth", "0");
    await expect.poll(() => parents(core)).toMatchObject({ [IDS.delta]: null, [IDS.alpha]: IDS.delta });
    expect(await core.state(seeded.terminals.delta ?? "")).toBe("live");

    await rowAction(row(page, "space", IDS.delta), "Delete…");
    await dialog(page).getByRole("button", { name: "Delete all, end 2" }).click();
    await expect(row(page, "space", IDS.delta)).toHaveCount(0);
    await expect(row(page, "space", IDS.alpha)).toHaveCount(0);
    await expect.poll(() => core.state(seeded.terminals.alpha ?? "")).toBe("finished");
    await expect.poll(async () => (await core.layout()).spaces.map((s) => s.id)).toEqual([IDS.gamma]);
  });
});
