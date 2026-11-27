#!/usr/bin/env bash
# Claude Code SessionStart hook: label this hc terminal with the Claude session running in it
# (`claude.session`, `claude.cwd`), which is how herdr finds a pane's transcript for the chat view.
#
# F22: it never blocks Claude and never depends on herdr. It does not talk to the herdr app at all
# (only `hc`, and that detached with a time limit), reads stdin for at most 20 ms, and always exits 0
# at once, whatever is missing: no terminal id, no hc, no herdr, garbage input.
#
# Use it in ~/.claude/settings.json as the SessionStart hook command:
#   bash /path/to/herdr/deploy/hooks/session-label.sh
# Agent state (working, waiting, done, died) is NOT taken from hooks: herdr reads it from
# herdr-core's own per-terminal status and events.
[ -n "${HC_TERMINAL_ID-}" ] || exit 0
command -v hc >/dev/null 2>&1 || exit 0
# Ignore non-interactive (`claude -p` / `--print`) sessions, e.g. one an agent runs inside this pane: the
# nearest claude ancestor decides, so they never overwrite the pane's own labels.
pid=$PPID
for _ in 1 2 3 4 5 6 7 8; do
  [ "${pid:-0}" -gt 1 ] 2>/dev/null || break
  mapfile -d '' -t argv </proc/"$pid"/cmdline 2>/dev/null || break
  case "${argv[0]-} ${argv[1]-}" in
    */claude\ *|claude\ *|*\ */claude|*\ claude)
      for a in "${argv[@]:1}"; do   # flags only: stop at a multi-word argument (the prompt)
        case "$a" in -p|--print|--print=*) exit 0 ;; *[[:space:]]*) break ;; esac
      done
      break ;;
  esac
  pid=$(awk '{print $4}' /proc/"$pid"/stat 2>/dev/null) || break
done
input=
IFS= read -r -t 0.02 -d '' input 2>/dev/null || true
session=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9_-]*\)".*/\1/p')
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p')
[ -n "$session" ] || exit 0
run=hc
command -v timeout >/dev/null 2>&1 && run="timeout 5 hc"
# shellcheck disable=SC2086
( $run label "$HC_TERMINAL_ID" "claude.session=$session" "claude.cwd=$cwd" </dev/null >/dev/null 2>&1 & )
exit 0
