import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { QaCore } from "./qa-core.ts";

// The standard QA world, shaped like Herdr Desktop's data:
//
//   (loose)  beta    tabs "main" (split: beta-a | beta-b) and "2" (beta-c)
//   (loose)  delta   unnamed space, named from its terminals' `where` label
//   work     gamma   (group, colour ansi2)
//     inner  alpha   (group inside work)
//   empty           (group with no spaces)
//
// The layout doc lists the spaces in the order alpha, beta, gamma, delta (as if Desktop had not
// sorted yet), so the expected order only holds if herdr applies Desktop's ungrouped-first rule.

export const IDS = {
  alpha: "spa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  beta: "spb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
  gamma: "spc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
  delta: "spd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
  work: "gqawork",
  inner: "gqainner",
  empty: "gqaempty",
} as const;

const tabId = (space: string, n: number) => `tb${space.slice(2, 33)}${String(n)}`;

const block = (terminal: string) => ({ type: "block", id: `pa${terminal}`, content: { terminal } });
const tab = (id: string, name: string, root: unknown) => ({ id, name, root });
const row = (id: string, children: unknown[]) => ({ type: "row", id, children });

export interface Seeded {
  readonly terminals: Readonly<Record<string, string>>;
  readonly layout: { spaces: { id: string; name: string; folder: string; tabs: unknown[] }[] };
  readonly groups: { version: number; groups: unknown[]; spaces: Record<string, unknown> };
}

export function groupsFixture(): Seeded["groups"] {
  return {
    version: 2,
    groups: [
      { id: IDS.work, name: "work", parent: null, parentId: null, color: "ansi2" },
      { id: IDS.inner, name: "inner", parent: "work", parentId: IDS.work, color: null },
      { id: IDS.empty, name: "empty", parent: null, parentId: null, color: null },
    ],
    spaces: {
      [IDS.alpha]: { name: "alpha", group: "inner", groupId: IDS.inner, color: null },
      [IDS.gamma]: { name: "gamma", group: "work", groupId: IDS.work, color: null },
      [IDS.beta]: { name: "beta", group: null, groupId: null, color: null },
    },
  };
}

/** Reset the QA core and groups file to the standard world. */
export async function seed(core: QaCore): Promise<Seeded> {
  await core.killAll();
  const at = (space: keyof typeof IDS, n: number, where: string) => ({ "herdr.space": IDS[space], "herdr.tab": tabId(IDS[space], n), where });
  const t = {
    alpha: await core.run("alpha-shell", at("alpha", 1, "alpha / 1")),
    // A real, quiet shell, so terminal tests can type into it.
    betaA: await core.run("beta-a", at("beta", 1, "beta / main"), ["env", "PS1=qa$ ", "bash", "--norc", "--noprofile", "-i"]),
    betaB: await core.run("beta-b", at("beta", 1, "beta / main")),
    betaC: await core.run("beta-c", at("beta", 2, "beta / 2")),
    gamma: await core.run("gamma-shell", at("gamma", 1, "gamma / 1")),
    delta: await core.run("delta-shell", at("delta", 1, "delta-from-where / 1")),
  };
  const layout = {
    spaces: [
      { id: IDS.alpha, name: "alpha", folder: "/tmp", tabs: [tab(tabId(IDS.alpha, 1), "", row(tabId(IDS.alpha, 1), [block(t.alpha)]))] },
      {
        id: IDS.beta,
        name: "beta",
        folder: "/tmp",
        tabs: [
          tab(tabId(IDS.beta, 1), "main", row(tabId(IDS.beta, 1), [block(t.betaA), block(t.betaB)])),
          tab(tabId(IDS.beta, 2), "", row(tabId(IDS.beta, 2), [block(t.betaC)])),
        ],
      },
      { id: IDS.gamma, name: "gamma", folder: "/tmp", tabs: [tab(tabId(IDS.gamma, 1), "", row(tabId(IDS.gamma, 1), [block(t.gamma)]))] },
      { id: IDS.delta, name: "", folder: "/tmp", tabs: [tab(tabId(IDS.delta, 1), "", row(tabId(IDS.delta, 1), [block(t.delta)]))] },
    ],
  };
  await core.setLayout(layout);
  // No space is marked quiet in herdr-tree (a test that marks one must not leak into the next).
  const tree = await core.call("doc.get", { name: "herdr-tree" });
  if (tree.value !== null && tree.value !== undefined) await core.call("doc.set", { name: "herdr-tree", version: tree.version, value: { root: "", spaces: {} } });
  const groups = groupsFixture();
  core.writeGroups(groups);
  return { terminals: t, layout, groups };
}

/** A shell run under the name `claude`, so herdr-core reports Claude (not a shell) as the pane's foreground. */
const fakeClaudeSh = join(dirname(fileURLToPath(import.meta.url)), "fake-sh", "claude");

/** A program that reports itself as Claude Code in this state (OSC 7501), then waits. */
export function claudeProgram(state: "working" | "blocked" | "idle"): string[] {
  const kind = state === "blocked" ? ":kind=permission" : "";
  return [fakeClaudeSh, "-c", `printf '\\033]7501;state=${state}:app=claude-code${kind}\\a'; sleep 3600`];
}

/**
 * A program that reports itself as Claude Code and changes its reported state whenever `file`'s
 * content does (`working`, `blocked`, `idle`), so a test can drive a pane's status live.
 */
export function controlledClaude(file: string): string[] {
  const script = `last=x; while :; do s=$(cat '${file}' 2>/dev/null); if [ "$s" != "$last" ]; then last=$s; if [ "$s" = blocked ]; then printf '\\033]7501;state=blocked:app=claude-code:kind=permission\\a'; else printf '\\033]7501;state=%s:app=claude-code\\a' "$s"; fi; fi; sleep 0.2; done`;
  return [fakeClaudeSh, "-c", script];
}

/** Add a tab holding one new terminal to a seeded space, as Desktop would when a tab is created. */
export async function addTab(core: QaCore, seeded: Seeded, space: keyof typeof IDS, name: string, program: string[], extraLabels: Record<string, string> = {}, cwd?: string): Promise<string> {
  const target = seeded.layout.spaces.find((s) => s.id === IDS[space]);
  if (target === undefined) throw new Error(`no space ${space}`);
  const n = target.tabs.length + 1;
  const address = await core.run(name, { "herdr.space": IDS[space], "herdr.tab": tabId(IDS[space], n), where: `${target.name} / ${name}`, ...extraLabels }, program, cwd);
  target.tabs.push(tab(tabId(IDS[space], n), name, row(tabId(IDS[space], n), [block(address)])));
  await core.setLayout(seeded.layout);
  return address;
}
