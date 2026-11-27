import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { appendTranscript, writeTranscript } from "../support/claude.ts";
import { addTab, controlledClaude, IDS, seed } from "../support/fixture.ts";
import { qaCore } from "../support/world.ts";

// F123: conversation mode. Speech recognition and synthesis are stubbed: starting it opens the mic,
// what is "heard" is sent to the session, the reply is spoken once the agent is idle, and a big
// mic button then starts the next turn.

const SESSION = "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CWD = "/tmp/herdr-qa-conv-proj";

test.describe("@F123 conversation mode", () => {
  test("hears, sends, speaks the reply, then offers the big mic for a follow-up", async ({ page }) => {
    const core = qaCore();
    const dir = mkdtempSync(join(tmpdir(), "herdr-qa-conv-"));
    try {
      const state = join(dir, "state");
      writeFileSync(state, "idle");
      await seed(core).then(async (seeded) => {
        const path = writeTranscript(core, CWD, SESSION, [JSON.stringify({ type: "user", uuid: "u0", message: { role: "user", content: "earlier question" } }), JSON.stringify({ type: "assistant", uuid: "a0", message: { id: "m0", content: [{ type: "text", text: "Earlier answer, not to be read." }] } })]);
        await addTab(core, seeded, "alpha", "voice", controlledClaude(state), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
        await page.addInitScript(() => {
          const w = window as unknown as Record<string, unknown>;
          w.__heard = ["fix the typo", "and now the tests"];
          w.__starts = 0;
          w.__spoken = [] as string[];
          w.__rates = [] as number[];
          w.__cancels = 0;
          class FakeRecognition {
            lang = "";
            continuous = false;
            interimResults = false;
            onresult: ((e: unknown) => void) | null = null;
            onerror: ((e: unknown) => void) | null = null;
            onend: (() => void) | null = null;
            start() {
              w.__starts = (w.__starts as number) + 1;
              const text = (w.__heard as string[]).shift() ?? "";
              setTimeout(() => {
                if (text !== "") this.onresult?.({ results: [Object.assign([{ transcript: text }], { isFinal: true })] });
                this.onend?.();
              }, 50);
            }
            stop() {}
            abort() {}
          }
          w.SpeechRecognition = FakeRecognition;
          w.__mic = "";
          Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {
              getUserMedia: () => ((w.__mic as string) === "" ? Promise.resolve({ getTracks: () => [] }) : Promise.reject(new DOMException("denied", w.__mic as string))),
            },
          });
          w.SpeechSynthesisUtterance = class {
            onend: (() => void) | null = null;
            onerror: (() => void) | null = null;
            lang = "";
            rate = 1;
            text: string;
            constructor(text: string) {
              this.text = text;
            }
          };
          Object.defineProperty(window, "speechSynthesis", {
            value: {
              speak(this: unknown, u: { text: string; rate: number; onend: (() => void) | null }) {
                (w.__spoken as string[]).push(u.text);
                (w.__rates as number[]).push(u.rate);
                (this as { current: unknown }).current = u;
                const self = this as { current: unknown };
                setTimeout(() => {
                  if (self.current === u) self.current = null;
                  u.onend?.();
                }, (w.__speakMs as number | undefined) ?? 50);
              },
              // Real browsers fire the utterance's error event after a cancel.
              current: null as null | { onerror: (() => void) | null },
              cancel() {
                w.__cancels = (w.__cancels as number) + 1;
                const u = (this as { current: null | { onerror: (() => void) | null } }).current;
                if (u !== null) setTimeout(() => u.onerror?.(), 10);
              },
            },
          });
        });
        await page.goto(`/s/${IDS.alpha}`);
        await page.getByRole("tab", { name: "voice", exact: true }).click();
        await expect(page.getByTestId("chat-view")).toHaveAttribute("data-state", "live");

        await page.getByTestId("conv-start").click();
        // Heard: lands in the composer, not sent. End sits in the composer row.
        await expect(page.getByTestId("composer-text")).toHaveValue("fix the typo");
        await expect(page.getByTestId("conv")).toHaveAttribute("data-phase", "drafted");
        await expect(page.locator('[data-testid="composer"] [data-testid="conv-end"]')).toBeVisible();
        await page.waitForTimeout(500);
        await expect(page.getByTestId("chat-working")).toBeHidden();
        // Edited and sent by the user; the agent starts working.
        await page.getByTestId("composer-text").fill("fix the typo please");
        await page.getByTestId("send").click();
        await expect(page.getByTestId("conv-state")).toHaveText("Claude is working… (tap to stop waiting)", { timeout: 30_000 });
        writeFileSync(state, "working");
        await expect(page.getByTestId("chat-working")).toBeVisible();
        appendTranscript(path, [JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "fix the typo please" } }), JSON.stringify({ type: "assistant", uuid: "a1", message: { id: "m1", content: [{ type: "text", text: "Fixed **the typo**." }] } })]);
        // Not read while it is still working.
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken)).toEqual([]);
        // The speed setting is the utterance's rate.
        await page.getByTestId("conv-rate").selectOption("1.5");
        writeFileSync(state, "idle");
        await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken)).toEqual(["Fixed the typo."]);
        expect(await page.evaluate(() => (window as unknown as { __rates: number[] }).__rates)).toEqual([1.5]);
        // After the read-out the mic restarts by itself; its words wait in the composer.
        await expect(page.getByTestId("composer-text")).toHaveValue("and now the tests");
        await expect(page.getByTestId("conv")).toHaveAttribute("data-phase", "drafted");
        expect(await page.evaluate(() => (window as unknown as { __starts: number }).__starts)).toBe(2);
        await page.getByTestId("composer-text").fill("");
        // Stop speaking cuts the read-out and does not restart the mic.
        await page.evaluate(() => {
          (window as unknown as { __speakMs: number }).__speakMs = 60_000;
          (window as unknown as { __heard: string[] }).__heard.push("one more");
        });
        await page.getByTestId("conv-mic").click();
        await expect(page.getByTestId("composer-text")).toHaveValue("one more");
        await page.getByTestId("send").click();
        await expect(page.getByTestId("conv-state")).toHaveText("Claude is working… (tap to stop waiting)", { timeout: 30_000 });
        writeFileSync(state, "working");
        await expect(page.getByTestId("chat-working")).toBeVisible();
        appendTranscript(path, [JSON.stringify({ type: "assistant", uuid: "a2", message: { id: "m2", content: [{ type: "text", text: "Third reply." }] } })]);
        writeFileSync(state, "idle");
        await expect(page.getByTestId("conv")).toHaveAttribute("data-phase", "speaking");
        await page.getByTestId("conv-stop").click();
        await expect(page.getByTestId("conv")).toHaveAttribute("data-phase", "ready");
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => (window as unknown as { __starts: number }).__starts)).toBe(3);
        expect(await page.evaluate(() => (window as unknown as { __cancels: number }).__cancels)).toBeGreaterThan(0);
        // End leaves the mode.
        await page.getByTestId("conv-end").click();
        await expect(page.getByTestId("conv-start")).toBeVisible();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tells the user when the browser won't restart the mic by itself", async ({ page }) => {
    const core = qaCore();
    const dir = mkdtempSync(join(tmpdir(), "herdr-qa-conv-"));
    try {
      const state = join(dir, "state");
      writeFileSync(state, "idle");
      await seed(core).then(async (seeded) => {
        const path = writeTranscript(core, CWD, SESSION, [JSON.stringify({ type: "user", uuid: "u0", message: { role: "user", content: "hi" } })]);
        await addTab(core, seeded, "alpha", "voice", controlledClaude(state), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
        await page.addInitScript(() => {
          const w = window as unknown as Record<string, unknown>;
          w.__starts = 0;
          w.SpeechRecognition = class {
            onresult: ((e: unknown) => void) | null = null;
            onerror: ((e: unknown) => void) | null = null;
            onend: (() => void) | null = null;
            start() {
              w.__starts = (w.__starts as number) + 1;
              const first = w.__starts === 1;
              setTimeout(() => {
                if (first) this.onresult?.({ results: [Object.assign([{ transcript: "hello" }], { isFinal: true })] });
                else this.onerror?.({ error: "not-allowed" });
                this.onend?.();
              }, 50);
            }
            stop() {}
            abort() {}
          };
          Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) } });
          w.SpeechSynthesisUtterance = class {
            onend: (() => void) | null = null;
            onerror: (() => void) | null = null;
          };
          Object.defineProperty(window, "speechSynthesis", { value: { speak(u: { onend: (() => void) | null }) { setTimeout(() => u.onend?.(), 50); }, cancel() {} } });
        });
        await page.goto(`/s/${IDS.alpha}`);
        await page.getByRole("tab", { name: "voice", exact: true }).click();
        await expect(page.getByTestId("chat-view")).toHaveAttribute("data-state", "live");
        await page.getByTestId("conv-start").click();
        await expect(page.getByTestId("composer-text")).toHaveValue("hello");
        await page.getByTestId("send").click();
        await expect(page.getByTestId("conv-state")).toHaveText("Claude is working… (tap to stop waiting)", { timeout: 30_000 });
        writeFileSync(state, "working");
        await expect(page.getByTestId("chat-working")).toBeVisible();
        appendTranscript(path, [JSON.stringify({ type: "assistant", uuid: "a1", message: { id: "m1", content: [{ type: "text", text: "Hi there." }] } })]);
        writeFileSync(state, "idle");
        await expect(page.getByTestId("conv-error")).toContainText("wouldn't turn the mic back on");
        await expect(page.getByTestId("conv")).toHaveAttribute("data-phase", "ready");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shows mic permission and recognition errors instead of a silent listening state", async ({ page }) => {
    const core = qaCore();
    await seed(core).then(async (seeded) => {
      const dir = mkdtempSync(join(tmpdir(), "herdr-qa-conv-"));
      test.info().annotations.push({ type: "dir", description: dir });
      const state = join(dir, "state");
      writeFileSync(state, "idle");
      writeTranscript(core, CWD, SESSION, [JSON.stringify({ type: "user", uuid: "u0", message: { role: "user", content: "hi" } })]);
      await addTab(core, seeded, "alpha", "voice", controlledClaude(state), { "claude.session": SESSION, "claude.cwd": CWD }, "/tmp");
      await page.addInitScript(() => {
        const w = window as unknown as Record<string, unknown>;
        w.__mic = "NotAllowedError";
        w.__starts = 0;
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: () => ((w.__mic as string) === "" ? Promise.resolve({ getTracks: () => [] }) : Promise.reject(new DOMException("denied", w.__mic as string))) },
        });
        w.SpeechRecognition = class {
          onerror: ((e: unknown) => void) | null = null;
          onend: (() => void) | null = null;
          start() {
            w.__starts = (w.__starts as number) + 1;
            setTimeout(() => {
              this.onerror?.({ error: "no-speech" });
              this.onend?.();
            }, 50);
          }
          stop() {}
          abort() {}
        };
        w.SpeechSynthesisUtterance = class {};
        Object.defineProperty(window, "speechSynthesis", { value: { speak() {}, cancel() {} } });
      });
      await page.goto(`/s/${IDS.alpha}`);
      await page.getByRole("tab", { name: "voice", exact: true }).click();
      await expect(page.getByTestId("chat-view")).toHaveAttribute("data-state", "live");
      // Mic denied: said so, recognition never started.
      await page.getByTestId("conv-start").click();
      await expect(page.getByTestId("conv-error")).toContainText("Microphone blocked");
      await expect(page.getByTestId("conv")).toHaveAttribute("data-phase", "ready");
      expect(await page.evaluate(() => (window as unknown as { __starts: number }).__starts)).toBe(0);
      // Granted, but nothing heard: also said so.
      await page.evaluate(() => ((window as unknown as { __mic: string }).__mic = ""));
      await page.getByTestId("conv-mic").click();
      await expect(page.getByTestId("conv-error")).toContainText("Didn't hear anything");
      await expect(page.getByTestId("conv")).toHaveAttribute("data-phase", "ready");
    });
  });
});
