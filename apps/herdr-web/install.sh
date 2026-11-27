#!/usr/bin/env bash
# Installs the herdr backend: build, the Claude hook, then the systemd user service:
#   ./install.sh steps          list steps: id<TAB>user|root<TAB>title
#   ./install.sh check <id>     0 done, 1 not done, 75 cannot tell, 2 usage error
#   ./install.sh apply <id>     do one step (idempotent)
#   ./install.sh show <id>      print what a step runs
#   ./install.sh apply          every step that is not done yet, in order
# Reaching it from your devices (an HTTPS proxy on this machine, such as `tailscale serve`) is
# not part of this script; see the README's Security section.
# Env: HERDR_NODE (node binary; default: nvm's default alias, then PATH, see deploy/run.sh),
#      HERDR_HOST (default 127.0.0.1), HERDR_PORT (default 7317), HERDR_UNIT_DIR (default
#      ~/.config/systemd/user; with it set systemctl is not touched, for tests),
#      HERDR_ALLOWED_SOURCE (the one source address the backend accepts, default 127.0.0.1:
#      the proxy on this machine),
#      HERDR_CREDENTIALS_FILE (the app login, default ~/.config/herdr/credentials.json),
#      HERDR_VAPID_FILE (the web push key pair, default ~/.config/herdr/vapid.json),
#      HERDR_CLAUDE_SETTINGS (where the hook step adds the SessionStart hook, default
#      $CLAUDE_CONFIG_DIR/settings.json or ~/.claude/settings.json).
set -euo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)      # this app (apps/herdr-web)
ROOT=$(cd "$DIR/../.." && pwd)                         # the repo root (npm workspaces)
UNIT_DIR=${HERDR_UNIT_DIR:-$HOME/.config/systemd/user}
UNIT="$UNIT_DIR/herdr.service"
PORT=${HERDR_PORT:-7317}
HOST=${HERDR_HOST:-127.0.0.1}
ALLOWED=${HERDR_ALLOWED_SOURCE:-127.0.0.1}
CREDENTIALS=${HERDR_CREDENTIALS_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/credentials.json}
VAPID=${HERDR_VAPID_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/vapid.json}
CLAUDE_SETTINGS=${HERDR_CLAUDE_SETTINGS:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json}
PRIVATE_DIRS=("${XDG_CONFIG_HOME:-$HOME/.config}/herdr" "${XDG_STATE_HOME:-$HOME/.local/state}/herdr")

STEPS=(
  "build	user	Install dependencies and build the UI"
  "dirs	user	Make herdr's config and state folders private (0700)"
  "login	user	Set the app login (username and password; prompts)"
  "vapid	user	Create the web push (VAPID) key pair"
  "hook	user	Add herdr's SessionStart hook to Claude Code's settings"
  "service	user	Install, enable and start the herdr user service"
  "smoke	user	Smoke test: the backend accepts connections"
  "bind	user	Verify the backend listens only on HERDR_HOST"
)

use_systemd() { [[ -z ${HERDR_UNIT_DIR:-} ]]; }
# The unit starts deploy/run.sh, which looks node up at every start (so nvm upgrades cannot leave
# the unit pointing at a deleted binary). HERDR_NODE, when set, is pinned into the unit.
node_bin() { "$DIR/deploy/run.sh" --print; }
render_unit() {   # the unit file with this checkout filled in
  sed -e "s|@DIR@|$DIR|g" -e "s|@ROOT@|$ROOT|g" -e "s|^Environment=HERDR_HOST=.*|Environment=HERDR_HOST=$HOST|" \
      -e "s|^Environment=HERDR_PORT=.*|Environment=HERDR_PORT=$PORT|" \
      -e "s|^Environment=HERDR_ALLOWED_SOURCE=.*|Environment=HERDR_ALLOWED_SOURCE=$ALLOWED|" \
      ${HERDR_NODE:+-e "/^Environment=HERDR_PORT=/a Environment=HERDR_NODE=$HERDR_NODE"} "$DIR/deploy/herdr.service"
}

# ---- steps ----

# Needs Node >= 24.7 (argon2 in node:crypto; the server runs TypeScript directly).
apply_build() {
  cd "$ROOT"
  npm ci
  npm run build -w herdr-web
}
check_build() {
  [[ -d $ROOT/node_modules && -f $DIR/dist/web/index.html ]] || { echo "node_modules or dist/web missing"; return 1; }
  echo "dependencies installed, UI built in dist/web"
}

# Task 052: the login, push keys, sessions and settings live in these folders; nobody else may
# list or enter them. The app creates them 0700, but folders made before that keep their mode.
apply_dirs() {
  local d
  for d in "${PRIVATE_DIRS[@]}"; do mkdir -p "$d" && chmod 700 "$d"; done
  check_dirs
}
check_dirs() {
  local d mode bad=0
  for d in "${PRIVATE_DIRS[@]}"; do
    [[ -d $d ]] || { echo "$d missing"; bad=1; continue; }
    mode=$(stat -c %a "$d")
    [[ $mode == 700 ]] || { echo "$d has mode $mode (want 700)"; bad=1; continue; }
    echo "$d is 0700"
  done
  return $bad
}

# F30: the app login on top of Authelia. Prompts for a username and a password (twice) on the
# terminal and stores only an argon2id hash, in a 0600 file outside the repo; the backend refuses
# to serve without it. Re-running it changes the password, which ends every login session; the
# running service picks the new file up without a restart.
apply_login() {
  [[ -t 0 ]] || { echo "the login step prompts for a password: run it in a terminal (./install.sh apply login)" >&2; return 1; }
  node_bin >/dev/null || { echo "node not found (set HERDR_NODE)" >&2; return 1; }
  local user pass pass2
  read -rp "herdr username [$USER]: " user
  user=${user:-$USER}
  IFS= read -rsp "herdr password (8+ characters): " pass; echo
  IFS= read -rsp "Again: " pass2; echo
  [[ $pass == "$pass2" ]] || { echo "the passwords differ" >&2; return 1; }
  printf '%s\n%s\n' "$user" "$pass" | HERDR_CREDENTIALS_FILE=$CREDENTIALS "$(node_bin)" "$DIR/src/server/auth/set-password.ts" "$CREDENTIALS"
}
check_login() {
  [[ -f $CREDENTIALS ]] || { echo "$CREDENTIALS missing"; return 1; }
  local mode; mode=$(stat -c %a "$CREDENTIALS")
  [[ $mode == 600 ]] || { echo "$CREDENTIALS has mode $mode (want 600)"; return 1; }
  grep -q '"hash":"\$argon2id\$' "$CREDENTIALS" || { echo "$CREDENTIALS holds no argon2id hash"; return 1; }
  echo "login set in $CREDENTIALS"
}

# F19: the web push key pair (VAPID). Created once, in a 0600 file outside the repo, and never
# overwritten: a new pair would void every browser's push subscription. The backend fails closed
# without it (push off, the rest of the app unaffected). The subscriptions themselves live in
# ~/.local/state/herdr/push.json (0600), made by the app. Back up vapid.json with the other
# secrets so a restored machine keeps its subscriptions.
apply_vapid() {
  node_bin >/dev/null || { echo "node not found (set HERDR_NODE)" >&2; return 1; }
  "$(node_bin)" "$DIR/src/server/push/gen-vapid.ts" "$VAPID"
}
check_vapid() {
  [[ -f $VAPID ]] || { echo "$VAPID missing"; return 1; }
  local mode; mode=$(stat -c %a "$VAPID")
  [[ $mode == 600 ]] || { echo "$VAPID has mode $mode (want 600)"; return 1; }
  grep -q '"publicKey":"' "$VAPID" && grep -q 'BEGIN PRIVATE KEY' "$VAPID" || { echo "$VAPID holds no key pair"; return 1; }
  echo "VAPID key pair in $VAPID"
}

# F22: the one Claude Code hook herdr relies on. SessionStart labels the terminal with its Claude
# session (deploy/hooks/session-label.sh), which is how a pane finds its transcript. Added to
# Claude's settings file unless a SessionStart hook there already runs it; a hand-written hook that sets
# claude.session= itself, or one running session-label.sh at another path (an older checkout layout),
# is replaced; every other setting is kept.
apply_hook() {
  node_bin >/dev/null || { echo "node not found (set HERDR_NODE)" >&2; return 1; }
  "$(node_bin)" "$DIR/deploy/hooks/install-hook.ts" apply "$CLAUDE_SETTINGS" "$DIR/deploy/hooks/session-label.sh"
}
check_hook() {   # 75 when the settings file is not valid JSON (cannot tell)
  node_bin >/dev/null || { echo "node not found (set HERDR_NODE)"; return 1; }
  "$(node_bin)" "$DIR/deploy/hooks/install-hook.ts" check "$CLAUDE_SETTINGS" "$DIR/deploy/hooks/session-label.sh"
}

# The unit is rewritten every time (it depends on this checkout and node path). Linger keeps the
# user manager, and so the service, running without a login and across reboots.
apply_service() {
  [[ -z ${HERDR_NODE:-} || -x $HERDR_NODE ]] || { echo "HERDR_NODE=$HERDR_NODE is not executable" >&2; return 1; }
  node_bin >/dev/null || { echo "node not found (set HERDR_NODE)" >&2; return 1; }
  install -d "$UNIT_DIR"
  render_unit > "$UNIT.tmp"
  mv "$UNIT.tmp" "$UNIT"
  if use_systemd; then
    systemctl --user daemon-reload
    systemctl --user enable herdr.service
    systemctl --user restart herdr.service
    loginctl enable-linger "$USER" || echo "could not enable linger; the service stops when you log out" >&2
  fi
}
check_service() {
  [[ -f $UNIT ]] || { echo "$UNIT missing"; return 1; }
  [[ "$(render_unit)" == "$(cat "$UNIT")" ]] || { echo "$UNIT differs from deploy/herdr.service for this checkout"; return 1; }
  use_systemd || { echo "$UNIT is current (systemctl skipped)"; return 0; }
  local s; s=$(systemctl --user is-active herdr.service 2>&1) || true
  local e; e=$(systemctl --user is-enabled herdr.service 2>&1) || true
  echo "herdr.service: $s, $e"
  [[ $s == active && $e == enabled ]]
}

apply_smoke() { check_smoke; }
# Only "is it up": the connection is accepted (a source other than HERDR_ALLOWED_SOURCE is then dropped).
check_smoke() {
  use_systemd || { echo "systemctl skipped"; return 0; }
  # Only probe when the address is local; otherwise the connect would go out to the default gateway.
  ip -4 -o addr show 2>/dev/null | grep -qwF "$HOST" || { echo "$HOST is not a local address yet"; return 75; }
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if (exec 3<>"/dev/tcp/$HOST/$PORT") 2>/dev/null; then
      echo "backend accepts connections on $HOST:$PORT"; return 0
    fi
    sleep 1
  done
  echo "nothing answers on $HOST:$PORT"; return 1
}

# The backend listens on nothing but HERDR_HOST (loopback by default), never 0.0.0.0.
apply_bind() { check_bind; }
check_bind() {
  local listeners
  listeners=$(ss -Hltn "sport = :$PORT" | awk '{print $4}')
  [[ -n $listeners ]] || { echo "nothing listens on port $PORT"; return 1; }
  if [[ $listeners != "$HOST:$PORT" ]]; then echo "port $PORT listens on: $listeners (want only $HOST:$PORT)"; return 1; fi
  echo "backend listens only on $HOST:$PORT"
}


# ---- dispatcher (the same in every project's install.sh) ----

usage() { sed -n '/^#   \.\/install/p' "$0" >&2; exit 2; }
step_ids() { local s; for s in "${STEPS[@]}"; do echo "${s%%$'\t'*}"; done; }
known() { step_ids | grep -x -- "$1" >/dev/null; }   # not -q: an early exit SIGPIPEs step_ids, which pipefail makes a miss
is_root_step() { local s; for s in "${STEPS[@]}"; do [[ $s == "$1"$'\t'root$'\t'* ]] && return 0; done; return 1; }
run_check() {   # normalises a check's result to 0 / 1 / 75
  local rc=0; "check_$1" || rc=$?
  case $rc in 0) return 0 ;; 75) return 75 ;; *) return 1 ;; esac
}
apply_one() {
  if is_root_step "$1" && [[ $EUID != 0 ]]; then echo "$1 needs root: sudo $0 apply $1" >&2; exit 1; fi
  "apply_$1"
}
apply_all() {
  local id rc root_left=()
  for id in $(step_ids); do
    rc=0; run_check "$id" >/dev/null || rc=$?
    if [[ $rc == 0 ]]; then echo "✓ $id: already done"; continue; fi
    if is_root_step "$id" && [[ $EUID != 0 ]]; then root_left+=("$id"); echo "… $id: needs root, skipped"; continue; fi
    echo "▶ $id"; "apply_$id"
    rc=0; run_check "$id" || rc=$?
    if [[ $rc == 1 ]]; then echo "✗ $id: still not done after apply"; exit 1; fi
  done
  for id in "${root_left[@]}"; do echo "Run as root: sudo $0 apply $id"; done
}

case "${1:-}" in
  steps) [[ $# == 1 ]] || usage; printf '%s\n' "${STEPS[@]}" ;;
  check) [[ $# == 2 ]] && known "$2" || usage; rc=0; run_check "$2" || rc=$?; exit $rc ;;
  show)  [[ $# == 2 ]] && known "$2" || usage; declare -f "apply_$2" "check_$2" ;;
  apply) if [[ $# == 1 ]]; then apply_all; else [[ $# == 2 ]] && known "$2" || usage; apply_one "$2"; fi ;;
  *) usage ;;
esac
