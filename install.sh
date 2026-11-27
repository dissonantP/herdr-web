#!/usr/bin/env bash
# The repo's install entry point (the installer's project-script contract): herdr-web's steps.
exec "$(dirname "${BASH_SOURCE[0]}")/apps/herdr-web/install.sh" "$@"
