import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F29: switching between existing tabs repeatedly must not leak terminals, sockets or memory, and
// the page must stay responsive (a phone crashed on opening a second tab).

test.beforeEach(async () => {
  await seed(qaCore());
});

async function heapMb(cdp: CDPSession): Promise<number> {
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = (await cdp.send("Runtime.getHeapUsage")) as { usedSize: number };
  return usedSize / 1024 / 1024;
}

async function counts(page: Page) {
  return page.evaluate(() => ({
    canvases: document.querySelectorAll("canvas").length,
    terminals: document.querySelectorAll('[data-testid="terminal"]').length,
    documentListeners: [...(window as unknown as { __docListeners: Map<string, number> }).__docListeners.values()].reduce((a, b) => a + b, 0),
    sockets: (window as unknown as { __sockets: { open: number } }).__sockets.open,
  }));
}

test.describe("@F29 tab switching", () => {
  test("20 tab switches keep one terminal, one socket, stable memory and a responsive page", async ({ page }) => {
    await page.addInitScript(() => {
      const state = { open: 0 };
      (window as unknown as { __sockets: typeof state }).__sockets = state;
      // Document listeners still attached: ghostty-web leaves some behind, each pinning a dead terminal.
      const listeners = new Map<string, number>();
      (window as unknown as { __docListeners: typeof listeners }).__docListeners = listeners;
      const add = EventTarget.prototype.addEventListener;
      const remove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, ...rest: [never, never?]) {
        if (this === document) listeners.set(type, (listeners.get(type) ?? 0) + 1);
        return add.call(this, type, ...rest);
      } as typeof add;
      EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, ...rest: [never, never?]) {
        if (this === document) listeners.set(type, (listeners.get(type) ?? 0) - 1);
        return remove.call(this, type, ...rest);
      } as typeof remove;
      const Native = window.WebSocket;
      class Counting extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          state.open++;
          this.addEventListener("close", () => {
            state.open--;
          });
        }
      }
      window.WebSocket = Counting;
    });
    const cdp = await page.context().newCDPSession(page);
    await page.goto(`/s/${IDS.beta}`);
    const tabs = page.getByRole("tab");
    await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");

    // Warm up with a few switches, then measure.
    const switchTo = async (n: number) => {
      await tabs.nth(n).click();
      await expect(tabs.nth(n)).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("terminal-view")).toHaveAttribute("data-state", "live");
    };
    for (let i = 0; i < 4; i++) await switchTo((i + 1) % 2);
    const listenersBefore = (await counts(page)).documentListeners;
    const before = await heapMb(cdp);
    for (let i = 0; i < 20; i++) {
      await switchTo((i + 1) % 2);
      const c = await counts(page);
      expect(c.terminals).toBe(1);
      expect(c.canvases).toBeLessThanOrEqual(2);
      expect(c.documentListeners, "document listeners pile up per tab switch").toBeLessThanOrEqual(listenersBefore + 1);
    }
    await expect.poll(async () => (await counts(page)).sockets).toBe(1);
    const after = await heapMb(cdp);
    expect(after - before, `heap grew from ${before.toFixed(1)} to ${after.toFixed(1)} MB`).toBeLessThan(25);

    // Still responsive: a round trip through the page's event loop is fast.
    const lag = await page.evaluate(() => new Promise<number>((resolve) => {
      const t = performance.now();
      setTimeout(() => resolve(performance.now() - t), 0);
    }));
    expect(lag).toBeLessThan(500);
  });
});
