// Row colours as Herdr Desktop draws them (dissonantP/herdr-mods mods/spaces-grouped/sidebar.js,
// `MARK` and the space/group row fill).

/** Desktop's palette for the ansi names, one strong hue each. */
export const ANSI: Readonly<Record<string, string>> = {
  ansi1: "#d9649a",
  ansi2: "#3fae6a",
  ansi3: "#e3814f",
  ansi4: "#5b8def",
  ansi5: "#8b7cf6",
  ansi6: "#22a99a",
};

export interface RowColour {
  /** The colour as `#rrggbb`. */
  readonly hue: string;
  /** `inv:`: the row is filled with the full colour and dark text; otherwise a soft tint. */
  readonly inverted: boolean;
}

/**
 * The colour a row shows. A space's own colour wins; with none it takes its group's; `dim` (or
 * nothing, or an unknown name) means no colour, and an own `dim` hides even a coloured group.
 */
export function resolveColour(own: string | null, inherited: string | null): RowColour | null {
  const token = own ?? inherited;
  if (token === null) return null;
  const inverted = token.startsWith("inv:");
  const name = inverted ? token.slice(4) : token;
  if (name === "dim") return null;
  const hue = /^#[0-9a-f]{6}$/i.test(name) ? name : ANSI[name];
  return hue === undefined ? null : { hue, inverted };
}

/** Inline style for a row: the CSS in app.css turns `--row-hue` into a tint or a solid fill. */
export function rowStyle(colour: RowColour | null): Record<string, string> {
  return colour === null ? {} : { "--row-hue": colour.hue };
}

/** Desktop's palette (same herdr-mods commit as above, the tokens `group-color` takes): the token each name writes. */
export const PALETTE: readonly (readonly [string, string])[] = [
  ["Teal", "ansi6"],
  ["Blue", "ansi4"],
  ["Purple", "ansi5"],
  ["Pink", "ansi1"],
  ["Orange", "ansi3"],
  ["Green", "ansi2"],
  ["Yellow", "#d9b54a"],
  ["Red", "#d9534f"],
  ["Grey", "#8a8f98"],
];
