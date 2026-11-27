// herdr: the terminal's colours, read from the theme.css tokens so the one theme file styles it too.

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export function readTerminalTheme(element: Element): TerminalTheme {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(`--term-${name}`).trim();
  return {
    background: token("bg"),
    foreground: token("fg"),
    cursor: token("cursor"),
    selectionBackground: token("selection"),
    black: token("black"),
    red: token("red"),
    green: token("green"),
    yellow: token("yellow"),
    blue: token("blue"),
    magenta: token("magenta"),
    cyan: token("cyan"),
    white: token("white"),
    brightBlack: token("bright-black"),
    brightRed: token("red"),
    brightGreen: token("green"),
    brightYellow: token("yellow"),
    brightBlue: token("blue"),
    brightMagenta: token("magenta"),
    brightCyan: token("cyan"),
    brightWhite: token("bright-white"),
  };
}
