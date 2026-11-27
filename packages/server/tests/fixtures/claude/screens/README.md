# Claude Code screens

Plain-text screens (what herdr-core's `terminal.read` returns) for the menu grammar in
`src/claude/menu.ts` and its tests.

- `live/`: Claude Code 2.1.325 (haiku) in an isolated herdr-core, 200 columns, read with `hc read`,
  2026-11-14; the working folder is shown as `/tmp/work`. Permission prompt, single, multiple-choice and
  multi-step questions (with their review steps and focused fields), plan approval.
- `collie/`: from AltanS/collie `web/src/fixtures/panes` at commit
  62e638c59770bb1ec58412732f59c102a717ede2 (MIT, Copyright (c) 2026 Altan Sarisin; notice in
  `third_party/collie-LICENSE`), colours and carriage returns stripped, names unchanged.

When a Claude Code update changes a menu, capture the new screen into `live/` and add it to
`menu.test.ts`.
