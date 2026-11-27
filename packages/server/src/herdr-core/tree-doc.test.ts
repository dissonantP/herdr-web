import { describe, expect, it } from "vitest";
import { parseLayout, parseTerminal } from "./client.ts";
import { nestingFacts } from "./adapter.ts";
import { effectiveParents, migrateTreeDoc, parseTreeDoc, reconcile, subtree, type EditableTreeDoc, type ReconcileFacts } from "./tree-doc.ts";

// F23's integrity rules on `herdr-tree`, pure.

const doc = (spaces: Record<string, Record<string, unknown>>): EditableTreeDoc => structuredClone({ spaces }) as EditableTreeDoc;

const facts = (spaces: string[], parentOfNew: Record<string, string | null> = {}, pending: string[] = []): ReconcileFacts => ({
  spaces: new Set(spaces),
  pending: new Set(pending),
  parentOfNew: (id) => (id in parentOfNew ? parentOfNew[id] : undefined),
});

describe("effectiveParents", () => {
  it("follows the doc, reading a missing parent and a cycle as top level", () => {
    const d = parseTreeDoc({ spaces: { r: { parent: "a" }, a: { parent: "r" }, b: { parent: "gone" }, c: { parent: "d" }, d: { parent: "c" }, e: { parent: "a" } } });
    const p = effectiveParents(d, new Set(["r", "a", "b", "c", "d", "e", "f"]));
    expect(Object.fromEntries(p)).toEqual({ r: null, a: null, b: null, c: null, d: null, e: null, f: null });
  });

  it("gives a subtree, the space first", () => {
    const p = new Map<string, string | null>([["a", null], ["b", "a"], ["c", "b"], ["d", null]]);
    expect(subtree(p, "a")).toEqual(["a", "b", "c"]);
    expect(subtree(p, "d")).toEqual(["d"]);
  });
});

describe("reconcile", () => {
  it("drops entries of spaces that are gone and moves their children up past them", () => {
    const d = doc({ a: { parent: null, quiet: false }, b: { parent: "a", quiet: true }, c: { parent: "b", quiet: false }, x: { parent: "c", quiet: false } });
    expect(reconcile(d, facts(["a", "x"]))).toBe(true);
    expect(d.spaces).toEqual({ a: { parent: null, quiet: false }, x: { parent: "a", quiet: false } });
  });

  it("nests a new space by its terminal, else at the top", () => {
    const d = doc({ a: { parent: null, quiet: false } });
    reconcile(d, facts(["a", "n1", "n2"], { n1: "a", n2: null }));
    expect(d.spaces.n1).toEqual({ parent: "a", quiet: false });
    expect(d.spaces.n2).toEqual({ parent: null, quiet: false });
    const self = doc({});
    reconcile(self, facts(["r"], { r: "r" }));
    expect(self.spaces.r).toEqual({ parent: null, quiet: false });
  });

  it("waits on a space it can't place yet, and leaves pending ones alone", () => {
    const d = doc({ p: { parent: "q", quiet: false } });
    expect(reconcile(d, facts(["n"], {}, ["p"]))).toBe(false);
    expect(d.spaces).toEqual({ p: { parent: "q", quiet: false } });
  });

  it("places a space whose quiet flag came before its place, keeping the flag", () => {
    const d = doc({ a: { parent: null, quiet: false }, n: { quiet: true } });
    reconcile(d, facts(["a", "n"], { n: "a" }));
    expect(d.spaces.n).toEqual({ parent: "a", quiet: true });
  });

  it("changes nothing on a doc that holds", () => {
    const d = doc({ a: { parent: null, quiet: false }, b: { parent: "a", quiet: false } });
    expect(reconcile(d, facts(["a", "b"]))).toBe(false);
  });
});

describe("migrateTreeDoc (task 065)", () => {
  const legacy = { root: "r", spaces: { r: { parent: null, quiet: false }, a: { parent: "r", quiet: true }, b: { parent: "a", quiet: false }, c: { parent: "r", quiet: false } }, extra: 1 };
  const fake = (value: unknown) => {
    const state = { value, version: 3, writes: 0 };
    return {
      state,
      getDoc: () => Promise.resolve({ value: structuredClone(state.value), version: state.version } as never),
      setDoc: (_name: string, v: unknown, version: number) => {
        expect(version).toBe(3);
        state.value = v;
        state.writes++;
        return Promise.resolve(undefined as never);
      },
    };
  };

  it("makes the root's children top level and drops the root field, keeping the rest", async () => {
    const rpc = fake(legacy);
    expect(await migrateTreeDoc(rpc)).toBe(true);
    expect(rpc.state.value).toEqual({ spaces: { r: { parent: null, quiet: false }, a: { parent: null, quiet: true }, b: { parent: "a", quiet: false }, c: { parent: null, quiet: false } }, extra: 1 });
  });

  it("writes nothing for a doc without a root", async () => {
    const rpc = fake({ spaces: { a: { parent: null, quiet: false } } });
    expect(await migrateTreeDoc(rpc)).toBe(false);
    expect(rpc.state.writes).toBe(0);
  });

  it("reads an unmigrated doc the same way", () => {
    expect(Object.fromEntries(effectiveParents(parseTreeDoc(legacy), new Set(["r", "a", "b", "c"])))).toEqual({ r: null, a: null, b: "a", c: null });
  });
});

describe("nestingFacts", () => {
  const layout = parseLayout({
    spaces: [
      { id: "spA", name: "a", folder: "/", tabs: [{ id: "tbA", name: "", root: { type: "block", id: "p1", content: { terminal: "t1" } } }] },
      { id: "spN", name: "n", folder: "/", tabs: [{ id: "tbN", name: "", root: { type: "block", id: "p2", content: { terminal: "t2" } } }] },
      { id: "spM", name: "m", folder: "/", tabs: [{ id: "tbM", name: "", root: { type: "block", id: "p3", content: { terminal: "t3" } } }] },
      { id: "spE", name: "e", folder: "/", tabs: [{ id: "tbE", name: "", root: { type: "block", id: "p4", content: { terminal: "t9" } } }] },
    ],
  });
  if (layout === null) throw new Error("bad layout");
  const t = (address: string, extra: Record<string, unknown>) => parseTerminal({ address, state: "live", labels: {}, ...extra } as never);

  it("asks the first terminal's parent terminal which space it is in", () => {
    const terminals = [t("t1", { labels: { "herdr.space": "spA" } }), t("t2", { parent: "t1" }), t("t3", { parent: "t7" }), t("t7", {}), t("t8", { parent: "t1" })];
    const f = nestingFacts(layout, terminals, new Set());
    expect(f.parentOfNew("spN")).toBe("spA");
    // The parent terminal has no label and no space shows it: no known parent.
    expect(f.parentOfNew("spM")).toBeNull();
    // No live terminal yet: can't tell.
    expect(f.parentOfNew("spE")).toBeUndefined();
    expect(f.parentOfNew("spA")).toBeNull();
  });

  it("falls back to the space whose layout shows the parent terminal", () => {
    const f = nestingFacts(layout, [t("t1", {}), t("t2", { parent: "t1" })], new Set());
    expect(f.parentOfNew("spN")).toBe("spA");
  });
});
