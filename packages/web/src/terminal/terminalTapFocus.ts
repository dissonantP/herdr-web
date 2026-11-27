// Borrowed from kcosr/herdr-web (MIT, Copyright (c) 2026 Kevin; full notice in
// third_party/herdr-web-LICENSE), file web/src/terminalTapFocus.ts at commit
// 92717f433b00881724b7f8bff328fb07d9fceab6. Changes for herdr are marked "herdr:".

export type TerminalTapFocusResult = boolean | "terminal";
export type TerminalTapFocusAction = "ignore" | "redirect" | "terminal";

export function terminalTapFocusAction(
  result: TerminalTapFocusResult | undefined,
  terminalHadFocusOrGrace: boolean,
): TerminalTapFocusAction {
  if (!result) {
    return "ignore";
  }
  if (result === "terminal" && terminalHadFocusOrGrace) {
    return "ignore";
  }
  return result === "terminal" ? "terminal" : "redirect";
}
