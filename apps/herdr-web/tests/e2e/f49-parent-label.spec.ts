import { expect, test } from "@playwright/test";
import { IDS, seed } from "../support/fixture.ts";
import type { QaCore } from "../support/qa-core.ts";
import { qaCore } from "../support/world.ts";

// F49: an agent moves its own space with `hc label "$HC_TERMINAL_ID" herdr.parent=<space name or id>`
// (`-`: top level); herdr applies it to herdr-tree, refuses cycles, and clears the label.
// No page involved, so it runs once (the phone project).

test.skip(({ isMobile }) => !isMobile, "no page involved");

async function parents(core: QaCore): Promise<Record<string, string | null>> {
  const doc = (await core.call("doc.get", { name: "herdr-tree" })).value as { spaces: Record<string, { parent: string | null }> } | null;
  return Object.fromEntries(Object.entries(doc?.spaces ?? {}).map(([id, e]) => [id, e.parent]));
}

async function labelOf(core: QaCore, address: string): Promise<string> {
  const list = (await core.call("terminal.list", {})).terminals as { address: string; labels: Record<string, string> }[];
  return list.find((t) => t.address === address)?.labels["herdr.parent"] ?? "";
}

test("@F49 a space moves under another by name, to the top with -, a cycle is refused, and the label is cleared", async () => {
  const core = qaCore();
  const seeded = await seed(core);
  const gamma = seeded.terminals.gamma ?? "";
  const alpha = seeded.terminals.alpha ?? "";

  core.label(gamma, { "herdr.parent": "alpha" });
  await expect.poll(() => parents(core), { timeout: 15_000 }).toMatchObject({ [IDS.gamma]: IDS.alpha });
  await expect.poll(() => labelOf(core, gamma), { timeout: 15_000 }).toBe("");

  // alpha under its own child gamma: refused, nothing moves, label still cleared.
  core.label(alpha, { "herdr.parent": IDS.gamma });
  await expect.poll(() => labelOf(core, alpha), { timeout: 15_000 }).toBe("");
  expect(await parents(core)).toMatchObject({ [IDS.gamma]: IDS.alpha, [IDS.alpha]: null });

  core.label(gamma, { "herdr.parent": "-" });
  await expect.poll(() => parents(core), { timeout: 15_000 }).toMatchObject({ [IDS.gamma]: null });
  await expect.poll(() => labelOf(core, gamma), { timeout: 15_000 }).toBe("");
});
