import type { DotState } from "./tree-utils.ts";

/** The one status dot: every place that shows a session's state renders this, so the same state always looks the same. */
export function StatusDot({ state, className, testId, label }: { readonly state: DotState; readonly className?: string; readonly testId?: string; readonly label?: string }) {
  const a11y = label === undefined ? {} : { role: "status", "aria-label": label, title: label };
  return <span className={`status status-${state}${className === undefined ? "" : ` ${className}`}`} data-testid={testId} {...a11y} />;
}
