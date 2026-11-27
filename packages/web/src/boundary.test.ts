import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The lint rule (eslint.config.js) that keeps this browser code on the server package's wire types only.

async function errors(code: string): Promise<string[]> {
  const [result] = await new ESLint().lintText(code, { filePath: "src/X.tsx" });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

describe("server package boundary", () => {
  it("allows the wire types and nothing else", async () => {
    expect(await errors('import type { ChatMessage } from "@herdr/server/chat.ts";\nexport type T = ChatMessage;\n')).toHaveLength(0);
    expect(await errors('import type { PaneStatus } from "@herdr/server/model.ts";\nexport type T = PaneStatus;\n')).toHaveLength(0);
    expect(await errors('import { HcClient } from "@herdr/server/herdr-core/client.ts";\nvoid HcClient;\n')).toHaveLength(1);
    expect(await errors('import { attachTerminalSockets } from "@herdr/server/terminal-socket.ts";\nvoid attachTerminalSockets;\n')).toHaveLength(1);
  }, 30_000); // the first ESLint run loads the typed config, which can take over 5 s on a busy machine
});
