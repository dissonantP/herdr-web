// Borrowed from kcosr/herdr-web (MIT, Copyright (c) 2026 Kevin; full notice in
// third_party/herdr-web-LICENSE), file web/src/terminalImeFocus.ts at commit
// 92717f433b00881724b7f8bff328fb07d9fceab6. Changes for herdr are marked "herdr:".

/**
 * Keep desktop terminal focus on the editable textarea after Ghostty's
 * selection manager moves it back to the non-editable terminal host.
 */
export function installTerminalImeFocusRedirect(options: {
  container: HTMLElement;
  textarea: HTMLTextAreaElement;
  hasAlternateTapFocus: () => boolean;
  focusTextarea: () => void;
}) {
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof Node) || !options.container.contains(target)) {
      return;
    }
    if (target === options.textarea || options.hasAlternateTapFocus()) {
      return;
    }
    options.focusTextarea();
  };

  options.container.addEventListener("focusin", onFocusIn);
  return () => options.container.removeEventListener("focusin", onFocusIn);
}
