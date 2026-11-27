import { expect, test } from "@playwright/test";
import { dialog, home, row, rowAction, rowByName, submitDialog, unfoldAll } from "../support/admin-ui.ts";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F10: create, rename and delete groups, spaces and tabs from herdr; each change lands in the
// herdr-app doc or the groups file (what Herdr Desktop reads) at once, Desktop's changes show in
// herdr within ~2 s, and a Desktop edit made meanwhile is kept.

test.describe("@F10 admin synced with Herdr Desktop", () => {
  let seeded: Awaited<ReturnType<typeof seed>>;
  test.beforeEach(async () => {
    seeded = await seed(qaCore());
  });

  test("groups: create, rename, delete", async ({ page }) => {
    const core = qaCore();
    await home(page);
    await page.getByTestId("add-node").click();
    await page.getByRole("menuitem", { name: "New group" }).click();
    await submitDialog(page, { Name: "fresh", Inside: IDS.work }, "Create");
    const made = core.readGroups().groups.find((g) => g.name === "fresh");
    expect(made?.id).toMatch(/^g[0-9a-z]+$/u);
    expect(made).toEqual({ id: made?.id, name: "fresh", parent: "work", parentId: IDS.work, color: null });
    await expect(rowByName(page, "group", "fresh")).toBeVisible();

    await rowAction(row(page, "group", made?.id ?? ""), "Rename");
    await submitDialog(page, { Name: "renamed" }, "Rename");
    expect(core.readGroups().groups.find((g) => g.id === made?.id)?.name).toBe("renamed");
    await expect(rowByName(page, "group", "renamed")).toBeVisible();

    await rowAction(row(page, "group", made?.id ?? ""), "Delete…", true);
    await expect(dialog(page)).toContainText("It is empty.");
    await dialog(page).getByRole("button", { name: "Delete" }).click();
    await expect(row(page, "group", made?.id ?? "")).toHaveCount(0);
    await expect.poll(() => core.readGroups().groups.map((g) => g.id)).toEqual([IDS.work, IDS.inner, IDS.empty]);
    // Exactly Desktop's schema, nothing extra.
    for (const g of core.readGroups().groups) expect(Object.keys(g).sort()).toEqual(["color", "id", "name", "parent", "parentId"]);
  });

  test("spaces: create in a group, rename, delete", async ({ page, isMobile }) => {
    const core = qaCore();
    await home(page);
    await rowAction(row(page, "group", IDS.empty), "New space here");
    await submitDialog(page, { Name: "made-here", Folder: "/tmp" }, "Create");
    // The new space opens.
    await expect(page.getByTestId("space-view").locator(".bar-title")).toHaveText("made-here");
    const space = (await core.layout()).spaces.find((s) => s.name === "made-here");
    expect(space?.folder).toBe("/tmp");
    expect(space?.tabs).toHaveLength(1);
    expect(core.readGroups().spaces[space?.id ?? ""]).toEqual({ name: "made-here", group: "empty", groupId: IDS.empty, color: null });
    // It runs a live shell carrying herdr-app's labels for it.
    const terminal = (await core.call("terminal.list", {})).terminals as { address: string; labels: Record<string, string> }[];
    expect(terminal.some((t) => t.labels["herdr.space"] === space?.id && t.labels["herdr.tab"] === space?.tabs[0]?.id)).toBe(true);

    if (isMobile) await page.getByRole("button", { name: "Back to spaces" }).click();
    await rowAction(row(page, "space", space?.id ?? ""), "Rename");
    await submitDialog(page, { Name: "renamed-space" }, "Rename");
    expect((await core.layout()).spaces.find((s) => s.id === space?.id)?.name).toBe("renamed-space");
    await expect(rowByName(page, "space", "renamed-space")).toBeVisible();

    await rowAction(row(page, "space", space?.id ?? ""), "Delete…");
    await dialog(page).getByRole("button", { name: /^Delete/u }).click();
    await expect(row(page, "space", space?.id ?? "")).toHaveCount(0);
    await expect.poll(async () => (await core.layout()).spaces.map((s) => s.id)).not.toContain(space?.id);
  });

  test("tabs: + in the tab strip, rename and close by long-press", async ({ page }) => {
    const core = qaCore();
    await page.goto(`/s/${IDS.gamma}`);
    await page.getByTestId("tab-add").click();
    await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
    const tabs = page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    const gamma = () => core.layout().then((l) => l.spaces.find((s) => s.id === IDS.gamma));
    const tabId = (await gamma())?.tabs[1]?.id ?? "";
    expect(tabId).toMatch(/^tb[0-9a-f]{32}$/u);

    await tabs.nth(1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename tab" }).click();
    await submitDialog(page, { Name: "logs" }, "Rename");
    await expect(tabs.nth(1)).toHaveText("logs");
    expect((await gamma())?.tabs[1]?.name).toBe("logs");

    await tabs.nth(1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Close tab…" }).click();
    await dialog(page).getByRole("button", { name: /^Close/u }).click();
    await expect(tabs).toHaveCount(1);
    await expect.poll(async () => (await gamma())?.tabs.map((t) => t.id)).not.toContain(tabId);
  });

  test("Desktop's changes show within ~2 s, and herdr's next writes keep them (the true race is in the unit tests)", async ({ page }) => {
    const core = qaCore();
    await home(page);
    // Desktop renames a group (groups file) and a space (layout doc).
    const groups = core.readGroups();
    groups.groups = groups.groups.map((g) => (g.id === IDS.empty ? { ...g, name: "from-desktop" } : g));
    core.writeGroups(groups);
    const layout = await core.layout();
    layout.spaces = layout.spaces.map((s) => (s.id === IDS.beta ? { ...s, name: "beta-desk" } : s));
    await core.setLayout(layout);
    await expect(rowByName(page, "group", "from-desktop")).toBeVisible({ timeout: 2000 });
    await expect(rowByName(page, "space", "beta-desk")).toBeVisible({ timeout: 2000 });

    // herdr renames other things right after: Desktop's edits survive.
    await rowAction(row(page, "group", IDS.work), "Rename");
    await submitDialog(page, { Name: "job" }, "Rename");
    await unfoldAll(page);
    await rowAction(row(page, "space", IDS.delta), "Rename");
    await submitDialog(page, { Name: "dee" }, "Rename");
    const after = core.readGroups();
    expect(after.groups.map((g) => g.name)).toEqual(["job", "inner", "from-desktop"]);
    expect(after.groups[1]?.parent).toBe("job");
    expect((await core.layout()).spaces.map((s) => s.name)).toEqual(["alpha", "beta-desk", "gamma", "dee"]);
    void seeded;
  });
});
