import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// F9's boundary is enforced by lint (eslint.config.js); this proves the rule bites.

async function errors(filePath: string, code: string): Promise<string[]> {
  const [result] = await new ESLint().lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports").map((m) => m.message);
}

describe("adapter boundary", () => {
  it("keeps the UI off the server", async () => {
    expect(await errors("src/web/X.tsx", 'import { HcClient } from "@herdr/server/herdr-core/client.ts";\nvoid HcClient;\n')).toHaveLength(1);
    expect(await errors("src/web/X.tsx", 'import type { Tree } from "../shared/model.ts";\nexport type T = Tree;\n')).toHaveLength(0);
  }, 30_000); // the first ESLint run loads the typed config, which takes over 5 s on a busy machine
  it("keeps the server's API side on the adapter interfaces", async () => {
    expect(await errors("src/server/http2.ts", 'import { HcClient } from "@herdr/server/herdr-core/client.ts";\nvoid HcClient;\n')).toHaveLength(1);
    expect(await errors("src/server/http2.ts", 'import { ClaudeCodeAgent } from "@herdr/server/claude/agent.ts";\nvoid ClaudeCodeAgent;\n')).toHaveLength(1);
    expect(await errors("src/server/main.ts", 'import { HcClient } from "@herdr/server/herdr-core/client.ts";\nvoid HcClient;\n')).toHaveLength(0);
  });
});
