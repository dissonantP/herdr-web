import { describe, expect, it } from "vitest";
import { parseLayout, parseTerminal, type WireTerminal } from "./client.ts";
import { parseGroups } from "./groups.ts";
import { buildTree, folderName, isAsleep } from "./tree.ts";
import { EMPTY_TREE_DOC } from "./tree-doc.ts";

const term = (address: string, extra: Record<string, unknown> = {}): WireTerminal =>
  parseTerminal({ address, name: "", state: "live", cwd: "/home/u/code", labels: {}, ...extra } as never);

const block = (id: string, terminal: string) => ({ type: "block", id, content: { terminal } });

// A layout doc as herdr-app writes it, with one split tab and one mod pane.
const layout = parseLayout({
  spaces: [
    { id: "sp1", name: "alpha", folder: "/home/u", tabs: [{ id: "tb1", name: "", root: { type: "row", id: "tb1", children: [block("p1", "t1")] } }] },
    {
      id: "sp2",
      name: "",
      folder: "/home/u/proj",
      tabs: [
        { id: "tb2", name: "main", root: { type: "row", id: "tb2", children: [block("p2", "t2"), { type: "column", id: "c", children: [block("p3", "t3"), { type: "block", id: "p4", content: { mod: "md-review", props: {} } }] }] } },
        { id: "tb3", name: "", root: { type: "row", id: "tb3", children: [block("p5", "t9")] } },
      ],
    },
    { id: "sp3", name: "gamma", folder: "/home/u", tabs: [{ id: "tb4", name: "", root: { type: "row", id: "tb4", children: [block("p6", "t4")] } }] },
  ],
} as never);

const groups = parseGroups(
  JSON.stringify({
    version: 2,
    groups: [
      { id: "g1", name: "work", parentId: null, color: "ansi1" },
      { id: "g2", name: "inner", parentId: "g1", color: null },
      { id: "g3", name: "empty", parentId: null, color: null },
    ],
    spaces: { sp1: { groupId: "g2" }, sp3: { groupId: "g1" } },
  }),
);

describe("buildTree", () => {
  const terminals = [
    term("t1", { name: "alpha-claude" }),
    term("t2", { labels: { where: "proj / main" } }),
    term("t3", { title: "vim" }),
    term("t4", { foreground: { name: "bash", cwd: "/home/u" } }),
    term("t5", { state: "finished" }),
    term("t6", { name: "stray" }),
    term("box/t7"),
  ];
  const tree = buildTree(terminals, layout, groups, "/home/u", EMPTY_TREE_DOC);

  it("keeps loose spaces first, then groups nested as Desktop draws them", () => {
    expect(tree.spaces.map((s) => s.id)).toEqual(["sp2"]);
    expect(tree.groups.map((g) => [g.id, g.spaces.map((s) => s.id), g.groups.map((c) => [c.id, c.spaces.map((s) => s.id)])])).toEqual([
      ["g1", ["sp3"], [["g2", ["sp1"]]]],
      ["g3", [], []],
    ]);
  });

  it("marks a pane labelled herdr.inbox=hide", () => {
    const labelled = buildTree([term("t1", { labels: { "herdr.inbox": "hide" } }), term("t2")], layout, groups, "/home/u", EMPTY_TREE_DOC);
    const panes = JSON.stringify(labelled);
    expect(panes).toContain('"inboxHidden":true');
    expect(panes.match(/inboxHidden/g)?.length).toBe(1);
  });

  it("names spaces and tabs like herdr-app", () => {
    const sp2 = tree.spaces[0];
    expect(sp2?.name).toBe("proj"); // from the `where` label
    expect(sp2?.tabs.map((t) => t.name)).toEqual(["main", "2"]);
    expect(tree.groups[0]?.groups[0]?.spaces[0]?.name).toBe("alpha");
  });

  it("lists a split tab's panes in layout order, mod panes included, live terminals only", () => {
    const sp2 = tree.spaces[0];
    expect(sp2?.tabs[0]?.panes.map((p) => [p.id, p.kind, p.name])).toEqual([
      ["t2", "terminal", "t2"],
      ["t3", "terminal", "vim"],
      ["p4", "mod", "md-review"],
    ]);
    expect(sp2?.tabs[1]?.panes).toEqual([]); // t9 is not live
  });

  it("leaves out live terminals no layout block holds (Desktop shows only placed ones)", () => {
    const ids = [...tree.spaces, ...tree.groups.flatMap((g) => g.spaces)].flatMap((s) => s.tabs.flatMap((t) => t.panes.map((p) => p.id)));
    expect(ids).not.toContain("t6");
  });

  it("marks the spaces in the quiet set", () => {
    const flat = (t: typeof tree) => [...t.spaces, ...t.groups.flatMap(function all(g: (typeof tree.groups)[number]): (typeof tree.spaces)[number][] { return [...g.spaces, ...g.groups.flatMap(all)]; })];
    const first = flat(tree)[0]?.id ?? "";
    const marked = flat(buildTree(terminals, layout, groups, "/home/u", { ...EMPTY_TREE_DOC, quiet: new Set([first]) }));
    expect(marked.filter((s) => s.quiet).map((s) => s.id)).toEqual([first]);
  });

  it("works with no layout doc and no groups", () => {
    const bare = buildTree([term("t1")], null, { groups: [], groupOf: new Map(), spaceColor: new Map() }, "/home/u", EMPTY_TREE_DOC);
    expect(bare.groups).toEqual([]);
    expect(bare.spaces).toEqual([]);
  });
});

describe("buildTree nesting (F23)", () => {
  const terminals = [term("t1"), term("t2"), term("t3"), term("t4")];
  const nest = (parents: Record<string, string | null>) => ({ ...EMPTY_TREE_DOC, parents: new Map(Object.entries(parents)) });

  it("draws a nested space only inside its parent, to any depth; groups hold top-level spaces only", () => {
    // sp1 (in group g2) holds sp2, which holds sp3 (whose own group g1 is then ignored).
    const tree = buildTree(terminals, layout, groups, "/home/u", nest({ sp2: "sp1", sp3: "sp2" }));
    expect(tree.spaces).toEqual([]);
    const inner = tree.groups[0]?.groups[0];
    expect(inner?.spaces.map((s) => s.id)).toEqual(["sp1"]);
    expect(inner?.spaces[0]?.children.map((s) => s.id)).toEqual(["sp2"]);
    expect(inner?.spaces[0]?.children[0]?.children.map((s) => s.id)).toEqual(["sp3"]);
    expect(tree.groups[0]?.spaces).toEqual([]);
  });

  it("draws a cycle in a hand-edited doc at the top level instead of losing it", () => {
    const tree = buildTree(terminals, layout, { groups: [], groupOf: new Map(), spaceColor: new Map() }, "/home/u", nest({ sp1: "sp2", sp2: "sp1" }));
    expect(tree.spaces.map((s) => s.id)).toEqual(["sp1", "sp2", "sp3"]);
  });
});

describe("folderName", () => {
  it("uses ~ for home and the last part otherwise", () => {
    expect(folderName("/home/u", "/home/u")).toBe("~");
    expect(folderName("/home/u/code/", "/home/u")).toBe("code");
    expect(folderName("~", "/home/u")).toBe("~");
  });
});

describe("isAsleep (F50)", () => {
  it("needs the sleep.session label and no Claude running", () => {
    const fg = (name: string) => ({ foreground: { name, pid: 1, cwd: "/", argv: [] } });
    expect(isAsleep(term("t1", { labels: { "sleep.session": "abc" }, ...fg("bash") }))).toBe(true);
    expect(isAsleep(term("t1", { labels: { "sleep.session": "abc" }, ...fg("claude") }))).toBe(false); // resumed by hand
    // The killed Claude's last status lingers; the foreground is what counts.
    expect(isAsleep(term("t1", { labels: { "sleep.session": "abc" }, status: { app: "claude-code", state: "idle" }, ...fg("bash") }))).toBe(true);
    expect(isAsleep(term("t1", { labels: {}, ...fg("bash") }))).toBe(false);
    expect(isAsleep(term("t1", { labels: { "sleep.session": "" } }))).toBe(false);
  });

  it("counts a shell with a claude.session label as asleep (after a reboot or /exit)", () => {
    const fg = (name: string) => ({ foreground: { name, pid: 1, cwd: "/", argv: [] } });
    expect(isAsleep(term("t1", { labels: { "claude.session": "abc" }, ...fg("bash") }))).toBe(true);
    expect(isAsleep(term("t1", { labels: { "claude.session": "abc" }, ...fg("claude") }))).toBe(false);
    expect(isAsleep(term("t1", { labels: { "claude.session": "abc" } }))).toBe(false);
    expect(isAsleep(term("t1", { labels: { "claude.session": "abc" }, ...fg("vim") }))).toBe(false); // not a shell: Resume would be refused
  });
});

describe("unseen (done past herdr.seen)", () => {
  const unseenOf = (extra: object) => {
    const t = term("t1", { status: { app: "claude-code", state: "done", kind: "" }, turn: 5, ...extra });
    const lay = parseLayout({ spaces: [{ id: "sp1", name: "a", folder: "/", tabs: [{ id: "tb1", name: "", root: { type: "row", id: "tb1", children: [block("p1", "t1")] } }] }] } as never);
    return buildTree([t], lay, parseGroups(JSON.stringify({ version: 2, groups: [], spaces: {} })), "/home/u", EMPTY_TREE_DOC).spaces[0]?.tabs[0]?.panes[0]?.program?.unseen;
  };
  it("is true only for a done pane whose turn is past the seen mark", () => {
    expect(unseenOf({ labels: { "herdr.seen": "3" } })).toBe(true);
    expect(unseenOf({})).toBe(true);
    expect(unseenOf({ labels: { "herdr.seen": "5" } })).toBe(false);
    expect(unseenOf({ status: { app: "claude-code", state: "idle", kind: "" } })).toBe(false);
  });
});
