import { describe, expect, it } from "vitest";
import { createSendOnce } from "./send-once.ts";

describe("sendOnce (task 139)", () => {
  it("shares a running send, remembers a finished one, and lets a failed one be retried", async () => {
    const sends = createSendOnce();
    let delivered = 0;
    let release: () => void = () => undefined;
    const slow = () => new Promise<void>((resolve) => ((release = resolve), void delivered++));
    const first = sends.once("p/1", slow);
    const retry = sends.once("p/1", slow);
    release();
    await Promise.all([first, retry]);
    await sends.once("p/1", slow);
    expect(delivered).toBe(1);
    const failing = sends.once("p/2", () => Promise.reject(new Error("no")));
    await expect(failing).rejects.toThrow("no");
    await sends.once("p/2", () => Promise.resolve(void delivered++));
    expect(delivered).toBe(2);
    await sends.once("p/3", () => Promise.resolve(void delivered++)); // another message
    expect(delivered).toBe(3);
  });
});
