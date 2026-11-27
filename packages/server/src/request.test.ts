import { describe, expect, it } from "vitest";
import { parseRequestUrl, sameOrigin } from "./request.ts";

describe("request checks", () => {
  it("refuses a page from another origin, and a request with no Origin (F27)", () => {
    expect(sameOrigin("https://herdr.example", "herdr.example")).toBe(true);
    expect(sameOrigin("https://evil.example", "herdr.example")).toBe(false);
    expect(sameOrigin("nonsense", "herdr.example")).toBe(false);
    expect(sameOrigin(undefined, "herdr.example")).toBe(false);
    expect(sameOrigin("https://herdr.example", undefined)).toBe(false);
    expect(sameOrigin("null", "herdr.example")).toBe(false);
    expect(sameOrigin("http://127.0.0.1:7317", "127.0.0.1:7317")).toBe(true);
  });
  it("parses a request path, or gives null for a malformed one instead of throwing", () => {
    expect(parseRequestUrl("/api/tree?x=1")?.pathname).toBe("/api/tree");
    for (const bad of ["//", "//[", "//a:b"]) expect(parseRequestUrl(bad)).toBeNull();
  });
});
