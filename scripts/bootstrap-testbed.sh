#!/usr/bin/env bash
#
# Puts the live testbed under .testbed/ (gitignored — never committed): a real Mastra app, built
# from testbed/, whose workflows run on PetriExecutionEngine, served by `mastra dev` (Mastra
# Studio) with the libpetri debug UI beside it in the same process.
#
#   scripts/bootstrap-testbed.sh            build the package, copy testbed/, pack + install, write .env
#   scripts/bootstrap-testbed.sh --refresh  rebuild and reinstall only this package (after a src/ change)
#   scripts/bootstrap-testbed.sh --check    report what is installed and its provenance
#   scripts/bootstrap-testbed.sh --clean    remove .testbed/ entirely
#
# Then:  cd .testbed && npm run dev      (Studio on :$MASTRA_PORT, debug UI on :$DEBUG_PORT)
#
# The package is consumed as a PACKED TARBALL of typescript/dist, not a symlink: a symlinked
# package resolves @mastra/core from typescript/node_modules, a second copy of Mastra beside the
# app's, and `mastra dev` bundles whatever a symlink points at. A tarball resolves its peer from
# the app, exactly as an installed release would.
#
# Figures measured here are TESTBED figures — a dev server, Studio, LibSQL, paced steps — and are
# never comparable with conformance or differential figures. .testbed/PROVENANCE records the tree
# every figure came from; quote it beside any number.
set -euo pipefail

# ---- pins -----------------------------------------------------------------------------------
# @mastra/core is the version scripts/mastra-pin records (and typescript/package.json develops
# against). `mastra` 1.30.0 is the CLI published in the same release train as core 1.67.0
# (both 2026-09-15); its @mastra/deployer is held at 1.67.0 by an override in testbed/package.json.
MASTRA_CLI_VERSION=1.30.0
MASTRA_PORT="${TESTBED_MASTRA_PORT:-4111}"
DEBUG_PORT="${TESTBED_DEBUG_PORT:-4112}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/testbed"
DEST="$REPO_ROOT/.testbed"
TS_DIR="$REPO_ROOT/typescript"
LIBPETRI_DIR="${LIBPETRI_DIR:-$(cd "$REPO_ROOT/.." && pwd)/libpetri}"
PIN_FILE="$REPO_ROOT/scripts/mastra-pin"

die() { printf '%s\n' "error: $*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }

[ -f "$PIN_FILE" ] || die "missing $PIN_FILE"
# shellcheck disable=SC1090
. "$PIN_FILE"

check_pins() {
  local core cli
  core="$(node -p "require('$SRC/package.json').dependencies['@mastra/core']")"
  cli="$(node -p "require('$SRC/package.json').devDependencies.mastra")"
  [ "$core" = "$MASTRA_DIST_VERSION" ] || die "testbed/package.json pins @mastra/core $core; scripts/mastra-pin says $MASTRA_DIST_VERSION"
  [ "$cli" = "$MASTRA_CLI_VERSION" ] || die "testbed/package.json pins mastra $cli; this script says $MASTRA_CLI_VERSION"
}

# The debug UI is libpetri's single-file build (Vite, base /debug/petri/ui/). The sibling checkout
# is a peer session's working tree: it is read, never built or modified here. Its dist/ is used when
# present; else the copy libpetri commits into its Java resources.
debug_ui_source() {
  local c
  for c in "${LIBPETRI_DEBUG_UI_HTML:-}" "$LIBPETRI_DIR/debug-ui/dist/index.html" "$LIBPETRI_DIR/java/src/main/resources/debug-ui/index.html"; do
    [ -n "$c" ] && [ -f "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

sha() { shasum -a 256 "$1" | cut -c1-12; }

package_rev() {
  local rev dirty=""
  rev="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  git -C "$REPO_ROOT" diff --quiet -- typescript/src 2>/dev/null || dirty="+dirty"
  printf '%s%s' "$rev" "$dirty"
}

dist_hash() {
  find "$TS_DIR/dist" -name '*.js' -type f -exec shasum -a 256 {} + | awk '{print $1}' | sort | shasum -a 256 | cut -c1-12
}

build_and_pack() {
  note "building typescript/ (npm run build)"
  (cd "$TS_DIR" && npm run build >/dev/null)
  mkdir -p "$DEST/vendor"
  local tgz
  tgz="$(cd "$TS_DIR" && npm pack --silent --pack-destination "$DEST/vendor")"
  mv -f "$DEST/vendor/$tgz" "$DEST/vendor/mastra-libpetri.tgz"
}

install_package() {
  # The tarball's content changes with every build; its lockfile integrity would pin the old one.
  # The testbed therefore keeps no lockfile: every direct dependency is pinned exactly instead.
  (cd "$DEST" && rm -rf node_modules/mastra-libpetri && npm install --no-package-lock --no-audit --no-fund --loglevel=error)
}

write_provenance() {
  local ui="$1"
  local libpetri_installed core_installed cli_installed
  libpetri_installed="$(node -p "require('$DEST/node_modules/libpetri/package.json').version")"
  core_installed="$(node -p "require('$DEST/node_modules/@mastra/core/package.json').version")"
  cli_installed="$(node -p "require('$DEST/node_modules/mastra/package.json').version")"
  {
    printf 'mastra-libpetri %s dist=%s\n' "$(package_rev)" "$(dist_hash)"
    printf 'libpetri %s (registry)\n' "$libpetri_installed"
    printf '@mastra/core %s, mastra CLI %s\n' "$core_installed" "$cli_installed"
    printf 'debug-ui %s sha256=%s (libpetri %s)\n' "$ui" "$(sha "$DEST/debug-ui/index.html")" \
      "$(git -C "$LIBPETRI_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    printf 'node %s, bootstrapped %s\n' "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$DEST/PROVENANCE"
  [ "$core_installed" = "$MASTRA_DIST_VERSION" ] || die "installed @mastra/core $core_installed, pinned $MASTRA_DIST_VERSION"
  # One libpetri: the engine's DebugSessionRegistry type and the app's must be the same module.
  [ -z "$(find "$DEST/node_modules" -path '*/node_modules/libpetri/package.json' -not -path "$DEST/node_modules/libpetri/package.json" | head -1)" ] \
    || die "more than one libpetri under .testbed/node_modules"
  cat "$DEST/PROVENANCE"
}

cmd="${1:-}"
case "$cmd" in
  --clean)
    rm -rf "$DEST"; note "removed $DEST"; exit 0 ;;
  --check)
    [ -d "$DEST/node_modules" ] || die "$DEST is not bootstrapped"
    cat "$DEST/PROVENANCE"
    printf 'current: mastra-libpetri %s dist=%s\n' "$(package_rev)" "$(dist_hash)"
    exit 0 ;;
  --refresh)
    [ -d "$DEST/node_modules" ] || die "$DEST is not bootstrapped; run without --refresh first"
    build_and_pack
    install_package
    ui="$(debug_ui_source)" || ui="(kept)"
    write_provenance "$ui"
    exit 0 ;;
  "") ;;
  *) die "unknown option $cmd" ;;
esac

command -v node >/dev/null || die "node not found"
check_pins

mkdir -p "$DEST"
# Sources only: node_modules, the database, recordings and .mastra/ output are the testbed's own.
(cd "$SRC" && find . -type f -not -path './node_modules/*' -print0 | while IFS= read -r -d '' f; do
  mkdir -p "$DEST/$(dirname "$f")"; cp "$f" "$DEST/$f"
done)

ui="$(debug_ui_source)" || die "no libpetri debug UI found (looked under $LIBPETRI_DIR); set LIBPETRI_DEBUG_UI_HTML"
mkdir -p "$DEST/debug-ui" "$DEST/recordings"
cp "$ui" "$DEST/debug-ui/index.html"

cat > "$DEST/.env" <<EOF
# Written by scripts/bootstrap-testbed.sh — regenerate rather than edit.
TESTBED_MASTRA_PORT=$MASTRA_PORT
TESTBED_DEBUG_PORT=$DEBUG_PORT
TESTBED_DEBUG_UI_HTML=$DEST/debug-ui/index.html
TESTBED_DB_URL=file:$DEST/testbed.db
EOF

build_and_pack
install_package
write_provenance "$ui"
note ""
note "ready:  cd .testbed && npm run dev"
note "        Studio    http://localhost:$MASTRA_PORT"
note "        debug UI  http://localhost:$DEBUG_PORT/debug/petri/ui/"
