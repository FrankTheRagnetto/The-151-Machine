#!/usr/bin/env bash
# tools/system-cleanup.sh — MECHANICAL system junk cleaner (no AI, forever).
# =============================================================================
# the owner's rule: delete ONLY real junk — never something that would
# just be downloaded or rebuilt again by itself. So:
#   - thumbnails: NOT deleted (they rebuild themselves at the next folder view);
#   - trash: NEVER touched, not even measured as "to clean";
#   - Spotify offline music and the app-building downloads (npm, Gradle,
#     Android, Playwright): kept, only their size is shown;
#   - yay (installed AUR programs): the clone and the CURRENT build stay (yay
#     reuses them); removed only what nothing will ever use again: build
#     leftovers (src/, pkg/), packages of old versions, source files of old
#     versions, folders of programs no longer installed.
# What needs root (pacman cache, system journal, orphans) is only MEASURED and
# printed as a command to paste — never run here, so this stays password-free
# and safe from a phone tap or terminal (`bash tools/system-cleanup.sh`).
# Test: tests/system-cleanup.test.js (fake home, fake pacman).
# =============================================================================
set -uo pipefail
export LC_ALL=C
HOME_DIR="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
YAY_DIR="$HOME_DIR/.cache/yay"

human() { numfmt --to=iec --suffix=B "${1:-0}" 2>/dev/null || echo "${1:-0}B"; }
# One number, always. `du` exits 1 on a single unreadable subfolder (pacman's
# root-only download-* dirs) but still prints the total: with pipefail the old
# `du | cut || echo 0` printed BOTH, and the report read «11GB 0».
sizeof() {
  local n
  n="$(du -sb "$1" 2>/dev/null | cut -f1)"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  echo "$n"
}

echo "== System cleanup =="
echo "$(date '+%Y-%m-%d %H:%M') · Removes only real junk. Trash, thumbnails, music, code and personal files are never touched."
echo

# --- yay: what no update will ever use again --------------------------------
freed=0
removed=0
rm_counted() { # $1 path (file or dir)
  local s; s="$(sizeof "$1")"
  if rm -rf -- "$1" 2>/dev/null; then
    freed=$(( freed + s )); removed=$(( removed + 1 ))
  fi
}
installed_version() { pacman -Q -- "$1" 2>/dev/null | awk '{print $2}'; }

# Names of the current sources in a .SRCINFO (`name::url` → name, else the last
# part of the URL without #fragment / ?query).
current_sources() {
  sed -n 's/^[[:space:]]*source\(_[a-z0-9_]*\)\{0,1\} = //p' "$1" | while IFS= read -r s; do
    case "$s" in
      *::*) echo "${s%%::*}" ;;
      *)    s="${s%%#*}"; s="${s%%\?*}"; echo "${s##*/}" ;;
    esac
  done
}

clean_yay_folder() { # $1 folder of one AUR package
  local d="$1" info="$1/.SRCINFO" names any=0 n f base ver
  [ -f "$info" ] || return 0   # not a yay build folder we understand: leave it
  names="$(sed -n 's/^pkgname = //p' "$info")"
  for n in $names; do [ -n "$(installed_version "$n")" ] && any=1; done
  if [ "$any" -eq 0 ]; then rm_counted "$d"; return 0; fi  # program uninstalled

  [ -d "$d/src" ] && rm_counted "$d/src"   # makepkg re-extracts every build
  [ -d "$d/pkg" ] && rm_counted "$d/pkg"

  # Built packages: keep only the installed version (and its .sig).
  for f in "$d"/*.pkg.tar.*; do
    [ -f "$f" ] || continue
    case "$f" in *.sig) continue ;; esac
    base="$(basename "$f")"; base="${base%.pkg.tar.*}"   # name-ver-rel-arch
    base="${base%-*}"                                   # name-ver-rel
    ver="${base##*-}"; base="${base%-*}"                # rel
    ver="${base##*-}-$ver"; n="${base%-*}"              # ver-rel, name
    if [ "$(installed_version "$n")" != "$ver" ]; then
      rm_counted "$f"; [ -f "$f.sig" ] && rm_counted "$f.sig"
    fi
  done

  # Downloaded source files of old versions. Only plain files that git does not
  # track and the current .SRCINFO does not list; folders (git sources) stay.
  if git -C "$d" rev-parse --git-dir >/dev/null 2>&1; then
    local keep tracked
    keep="$(current_sources "$info")"
    tracked="$(git -C "$d" ls-files 2>/dev/null)"
    for f in "$d"/*; do
      [ -f "$f" ] || continue
      base="$(basename "$f")"
      case "$base" in *.pkg.tar.*) continue ;; esac
      printf '%s\n' "$tracked" | grep -qxF -- "$base" && continue
      printf '%s\n' "$keep" | grep -qxF -- "$base" && continue
      rm_counted "$f"
    done
  fi
}

echo "-- Removed --"
if [ -d "$YAY_DIR" ] && command -v pacman >/dev/null 2>&1; then
  for d in "$YAY_DIR"/*/; do
    [ -d "$d" ] && clean_yay_folder "${d%/}"
  done
  if [ "$removed" -gt 0 ]; then
    echo "  ✓ Old program installers (yay): $(human "$freed") freed"
  else
    echo "  · Old program installers (yay): nothing to remove"
  fi
else
  echo "  · Old program installers (yay): nothing to remove"
fi
echo

# --- Kept on purpose: only shown ---------------------------------------------
echo "-- Kept (size only) --"
show() { # $1 label  $2 path
  [ -e "$2" ] && echo "  $1: $(human "$(sizeof "$2")")"
}
show "Spotify music"            "$HOME_DIR/.cache/spotify/Data"
show "npm downloads"            "$HOME_DIR/.npm"
show "Gradle downloads"         "$HOME_DIR/.gradle"
show "Android SDK"              "$HOME_DIR/Android/Sdk"
show "Android emulators"        "$HOME_DIR/.android"
show "Playwright browsers"      "$HOME_DIR/.cache/ms-playwright"
show "Thumbnails"               "$HOME_DIR/.cache/thumbnails"
show "Trash"                    "$HOME_DIR/.local/share/Trash"
echo

# --- Needs the password: measured, never run ---------------------------------
echo "-- Needs your password (paste in a terminal) --"
if [ -d /var/cache/pacman/pkg ]; then
  echo "  Old system packages (pacman): $(human "$(sizeof /var/cache/pacman/pkg)")"
  echo "    → sudo paccache -rk2 && sudo paccache -ruk0   # keeps the last 2 versions"
  if compgen -G '/var/cache/pacman/pkg/download-*' >/dev/null; then
    echo "  Broken downloads (pacman): $(compgen -G '/var/cache/pacman/pkg/download-*' | wc -l) folders"
    echo "    → sudo rm -rf /var/cache/pacman/pkg/download-*"
  fi
fi
if command -v journalctl >/dev/null 2>&1; then
  jsz="$(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMGT]' | head -1)"
  echo "  System log: ${jsz:-?}"
  echo "    → sudo journalctl --vacuum-time=2weeks"
fi
if command -v pacman >/dev/null 2>&1; then
  orph="$(pacman -Qdtq 2>/dev/null | grep -c . || true)"
  if [ "${orph:-0}" -gt 0 ]; then
    echo "  Unused packages: $orph"
    echo "    → sudo pacman -Rns \$(pacman -Qdtq)"
  else
    echo "  Unused packages: none ✓"
  fi
fi
echo
echo "Done."
