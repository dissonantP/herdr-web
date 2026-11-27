import { spawnSync } from "node:child_process";

// The project's check command. `npm run check` runs lint, typecheck, unit tests, a build and the
// whole Playwright suite against an isolated herdr-core. `npm run check -- F1 F2` runs only those
// criteria's Playwright tests (tagged `@F1`, `@F2`).

const ids = process.argv.slice(2).filter((a) => /^F\d+$/u.test(a));
const grep = ids.length > 0 ? ["--grep", ids.map((id) => `@${id}\\b`).join("|")] : [];

const steps: [string, string[]][] = [
  ["eslint", ["."]],
  ["tsc", ["-p", "tsconfig.json"]],
  ["vitest", ["run"]],
  ["vite", ["build", "--logLevel", "warn"]],
  ["playwright", ["test", ...grep]],
];

for (const [tool, args] of steps) {
  console.log(`\n▶ ${tool} ${args.join(" ")}`);
  const result = spawnSync("npx", [tool, ...args], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✗ ${tool} failed`);
    process.exit(result.status ?? 1);
  }
}
console.log("\n✓ check passed");
