import { describe, expect, it } from "vitest";
import { HcError } from "./client.ts";
import type { JsonValue } from "./json.ts";
import { readQuietSpaces, recordQuiet } from "./quiet.ts";

function fakeDoc(initial: JsonValue | null, race?: () => void) {
  let doc = { value: initial, version: 1 };
  let raced = race;
  return {
    value: () => doc.value,
    rpc: {
      getDoc: () => Promise.resolve(structuredClone(doc)),
      setDoc: (_name: string, value: JsonValue, version: number) => {
        if (raced) {
          raced();
          raced = undefined;
        }
        if (version !== doc.version) return Promise.reject(new HcError("conflict", "conflict"));
        doc = { value, version: version + 1 };
        return Promise.resolve();
      },
    },
    set: (value: JsonValue) => (doc = { value, version: doc.version + 1 }),
  };
}

describe("quiet flag in herdr-tree (F36)", () => {
  it("turns on and off, keeping every other field", async () => {
    const d = fakeDoc({ spaces: { r: { parent: null, quiet: false }, a: { parent: "r", quiet: false }, b: { parent: null, quiet: true } } });
    await recordQuiet(d.rpc, "a", true);
    expect([...(await readQuietSpaces(d.rpc))].sort()).toEqual(["a", "b"]);
    await recordQuiet(d.rpc, "b", false);
    expect(d.value()).toEqual({ spaces: { r: { parent: null, quiet: false }, a: { parent: "r", quiet: true }, b: { parent: null, quiet: false } } });
  });

  it("creates the doc for a first flag, and turning off a space it doesn't know writes nothing", async () => {
    const d = fakeDoc(null);
    await recordQuiet(d.rpc, "x", false);
    expect(d.value()).toBeNull();
    await recordQuiet(d.rpc, "x", true);
    // No `parent` yet: the space is still placed as new on the next tree read (tree-doc.ts reconcile).
    expect(d.value()).toEqual({ spaces: { x: { quiet: true } } });
  });

  it("starts again from a concurrent writer's version", async () => {
    const d = fakeDoc({ spaces: {} }, () => d.set({ spaces: { z: { parent: null, quiet: false } } }));
    await recordQuiet(d.rpc, "a", true);
    expect(d.value()).toEqual({ spaces: { z: { parent: null, quiet: false }, a: { quiet: true } } });
  });
});
