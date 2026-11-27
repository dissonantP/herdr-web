# Landing page design

Direction: the page is a herdr pane. It uses the app's own palette and structure (a tab strip on
top, sections split by 1 px rules like panes, flush screenshots on the same background), so the
page and the screenshots read as one surface. Terse, factual copy for Herdr users; no marketing.

Tokens (in `style.css`, taken from the app's `src/web/theme.css`):

- Fonts: Martian Mono for everything but long prose. The name at wdth 112.5, wght 800, -0.04em;
  section heads at wdth 100, wght 600, 15 px, lowercase with a `## ` prefix; labels, nav and code at
  wdth 87.5, 13-14 px. IBM Plex Sans 400/600, 16/1.55, for the lede, list items and security prose,
  at 62-68ch.
- Colours: `--bg` #111214 (the app background), `--panel` #17191c, `--line` #2a2d32, `--fg` #d9dadc,
  `--dim` #8b9097. `--working` #6ea8fe is the accent (links, the active nav tab, the cursor).
  `--waiting` #f2b134 only means "needs you": the security band and the inbox caption. `--idle`
  #6b665c only for list dashes.
- Layout: a 12-column grid, 1440 px max, 32 px gutters (16 px on phones). No boxed sections.
  - Hero: name, one-line description, lede and the install command (with a copy control) in
    columns 1-7, then the desktop screenshot flush across the grid. On phones, the phone chat
    screenshot full-bleed instead.
  - Features: one list of rows, each a mono label (cols 1-3), Plex items (cols 4-9) and, where one
    fits, a sticky phone screenshot cropped from the top (cols 10-12); on phones the screenshot
    follows its row. Limits is the last row.
  - Security: a full-width panel band with a 4 px waiting rule on the left, a mono heading with an
    amber `!`, and the two rules as a definition list.
  - Install: the commands in cols 1-8, what the installer touches in cols 9-12, a text link to the
    README. No buttons anywhere.
- Radii: 4 px on command strips only; screenshots are square-cornered.
- Motion: only a blinking block cursor after the name, off with reduced motion.
