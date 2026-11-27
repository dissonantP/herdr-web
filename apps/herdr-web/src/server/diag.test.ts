import { expect, test } from "vitest";
import { diagEntry } from "./diag.ts";

test("a report keeps only the known fields, with short strings", () => {
  const entry = diagEntry({ kind: "tap", sw: "/assets/index-a.js", target: "/inbox", cookie: "secret", tapped: "x".repeat(1000), matched: 1, windows: [{ url: "https://h/", controlled: false, extra: "no" }], nested: { a: 1 } });
  expect(entry).toEqual({ kind: "tap", sw: "/assets/index-a.js", target: "/inbox", tapped: "x".repeat(300), matched: 1, windows: [{ url: "https://h/", controlled: false, focused: undefined, visibility: undefined }] });
});

test("at most ten windows are kept", () => {
  const windows = Array.from({ length: 50 }, (_, i) => ({ url: String(i) }));
  expect((diagEntry({ windows }).windows as unknown[]).length).toBe(10);
});
