#!/usr/bin/env bash
# Launches The 151 Machine desktop app. Self-locating so it works from anywhere.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$DIR/node_modules/electron/dist/electron" "$DIR" --class=the-151-machine "$@"
