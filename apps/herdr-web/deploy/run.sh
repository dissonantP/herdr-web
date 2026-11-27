#!/usr/bin/env bash
# Starts the backend with a node that survives nvm upgrades: the node is looked up here, on every
# start, instead of being baked into the systemd unit. Order: $HERDR_NODE, then nvm's default alias
# (newest installed version it names), then node on PATH. `run.sh --print` prints the choice.
set -eu

resolve() {
  if [[ -n ${HERDR_NODE:-} ]]; then echo "$HERDR_NODE"; return; fi
  local nvm=${NVM_DIR:-$HOME/.nvm} alias="" v hops=0
  if [[ -r $nvm/alias/default ]]; then
    alias=$(<"$nvm/alias/default")
    while [[ -r $nvm/alias/$alias && $hops -lt 5 ]]; do alias=$(<"$nvm/alias/$alias"); hops=$((hops + 1)); done
    alias=${alias#v}
  fi
  # An alias that names no installed version (node, stable, lts/*, empty) means the newest installed one.
  case $alias in node|stable|system|lts/*|"") alias="" ;; esac
  local versions; versions=$(ls -1 "$nvm/versions/node" 2>/dev/null | sed 's/^v//' || true)
  v=$(grep -E "^${alias//./\\.}(\.|\$)" <<<"$versions" | sort -V | tail -1 || true)
  [[ -n $v ]] || v=$(sort -V <<<"$versions" | tail -1)
  if [[ -n $v && -x $nvm/versions/node/v$v/bin/node ]]; then echo "$nvm/versions/node/v$v/bin/node"; return; fi
  command -v node
}

node=$(resolve) || { echo "herdr: no node found (set HERDR_NODE)" >&2; exit 1; }
[[ -x $node ]] || { echo "herdr: $node is not executable" >&2; exit 1; }
if [[ ${1:-} == --print ]]; then echo "$node"; exit 0; fi
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec "$node" src/server/main.ts
