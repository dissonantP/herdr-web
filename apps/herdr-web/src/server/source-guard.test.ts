import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_SOURCE, isAllowedSource } from "./source-guard.ts";

describe("source guard", () => {
  it("allows only loopback (the proxy on this machine) by default", () => {
    expect(isAllowedSource("127.0.0.1", DEFAULT_ALLOWED_SOURCE)).toBe(true);
    expect(isAllowedSource("::ffff:127.0.0.1", DEFAULT_ALLOWED_SOURCE)).toBe(true);
    for (const other of ["127.0.0.2", "192.168.1.5", "100.64.0.1", "10.0.0.2", "", undefined]) {
      expect(isAllowedSource(other, DEFAULT_ALLOWED_SOURCE)).toBe(false);
    }
  });

  it("an explicitly allowed source is the only one served", () => {
    expect(isAllowedSource("192.0.2.7", "192.0.2.7")).toBe(true);
    expect(isAllowedSource("127.0.0.1", "192.0.2.7")).toBe(false);
  });
});
