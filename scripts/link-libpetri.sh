#!/usr/bin/env bash
#
# Links typescript/node_modules/libpetri at a sibling libpetri checkout.
#
# This is the DEFAULT for now, not an escape hatch. The engine calls surface that is
# committed but unreleased (TIME-015 injectable clock, the MOD-031 place-alias fix, NU-011
# resume-safe minting) plus the CORE-073 / ENV-014 snapshot surface, which is implemented but
# not yet committed. npm still publishes 6.0.0. Drop the link the day 6.1.0 publishes.
#
# A number produced against a linked tree is NOT comparable with one produced against a
# release. Unlink before measuring anything intended for reporting, and record which tree
# produced every conformance, differential or benchmark figure.
#
#   scripts/link-libpetri.sh            link, building the sibling's dist/ if absent
#   scripts/link-libpetri.sh --unlink   restore the registry copy
#   scripts/link-libpetri.sh --check    verify the link without changing anything
#   scripts/link-libpetri.sh --strict   as --check, but FAIL if the sibling tree is dirty
#   scripts/link-libpetri.sh --provenance  print the one line to quote next to a measurement
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS_DIR="$REPO_ROOT/typescript"
SIBLING="${LIBPETRI_DIR:-$(cd "$REPO_ROOT/.." && pwd)/libpetri}/typescript"
TARGET="$TS_DIR/node_modules/libpetri"
BACKUP="$TS_DIR/node_modules/.libpetri-registry"
PIN_FILE="$REPO_ROOT/scripts/libpetri-pin"

die() { printf '%s\n' "error: $*" >&2; exit 1; }

# A git revision identifies the linked tree only when that tree is clean. It usually is not:
# the CORE-073 / ENV-014 snapshot surface is deliberately uncommitted upstream, so the code
# that actually runs here is a working-tree build that no revision names. That is fine for
# development and fatal for a reported number, and the failure is silent — the pin matches
# HEAD, the check passes, and the figure is attributed to a revision that never produced it.
#
# So the identity reported is content-addressed: the revision, whether the tree is dirty, and
# a hash of the built artifact the package actually imports. Two different dirty states get
# two different fingerprints.
fingerprint_dist() {
  [ -d "$SIBLING/dist" ] || { echo "unbuilt"; return 0; }
  find "$SIBLING/dist" -name '*.js' -type f -exec shasum -a 256 {} + \
    | awk '{print $1}' | sort | shasum -a 256 | cut -c1-12
}

# A clean tree does not prove the build came from it: dist/ is gitignored, and it is what the
# package actually imports. Stale if any source file is newer than the oldest built file.
dist_stale() {
  [ -d "$SIBLING/dist" ] || return 0
  local oldest
  # Portable (BSD and GNU): the oldest top-level built file, then any source newer than it.
  oldest="$(ls -1tr "$SIBLING"/dist/*.js 2>/dev/null | head -1)"
  [ -n "$oldest" ] || return 0
  [ -n "$(find "$SIBLING/src" -name '*.ts' -type f -newer "$oldest" 2>/dev/null | head -1)" ]
}

sibling_rev() { git -C "$(dirname "$SIBLING")" rev-parse --short HEAD 2>/dev/null || echo unknown; }

sibling_dirty() {
  git -C "$(dirname "$SIBLING")" diff --quiet -- typescript 2>/dev/null && return 1
  return 0
}

# The one line to paste next to any figure measured against a linked tree.
provenance() {
  local rev dirty
  rev="$(sibling_rev)"
  if sibling_dirty; then dirty="+dirty"; else dirty=""; fi
  printf 'libpetri %s%s dist=%s\n' "$rev" "$dirty" "$(fingerprint_dist)"
}

check_pin() {
  [ -f "$PIN_FILE" ] || { echo "note: no $PIN_FILE yet; skipping revision check"; return 0; }
  local want have
  want="$(tr -d '[:space:]' < "$PIN_FILE")"
  have="$(git -C "$(dirname "$SIBLING")" rev-parse HEAD 2>/dev/null || echo unknown)"
  if [ "$want" != "$have" ]; then
    echo "warning: sibling libpetri is at $have, pin expects $want" >&2
    echo "         'works on this machine' is not a checkable claim; update scripts/libpetri-pin" >&2
    echo "         once you have confirmed the newer revision." >&2
  fi

  echo "provenance: $(provenance)"
  if dist_stale; then
    echo "warning: a source file under the sibling's typescript/src is newer than its dist/," >&2
    echo "         so the code that runs was not built from the tree the pin names." >&2
    echo "         Rebuild the sibling (npm run build) before attributing a figure." >&2
    [ "${STRICT:-0}" = "1" ] && die "refusing to certify a stale build (--strict)"
  fi
  if sibling_dirty; then
    echo "warning: the sibling's typescript/ tree has uncommitted changes, so the pinned" >&2
    echo "         revision does NOT describe the code that runs. Expected while CORE-073" >&2
    echo "         is unlanded, but no figure measured here may be attributed to $want." >&2
    echo "         Quote the provenance line above instead, or --unlink and measure." >&2
    [ "${STRICT:-0}" = "1" ] && die "refusing to certify a dirty tree (--strict)"
  fi
  return 0
}

case "${1:-}" in
  --unlink)
    [ -L "$TARGET" ] || die "$TARGET is not a symlink; nothing to unlink"
    rm "$TARGET"
    if [ -d "$BACKUP" ]; then mv "$BACKUP" "$TARGET"; echo "restored the registry copy"; fi
    echo "unlinked. Numbers measured from here are comparable with a release."
    exit 0
    ;;
  --check)
    [ -L "$TARGET" ] || die "not linked: $TARGET"
    echo "linked: $TARGET -> $(readlink "$TARGET")"
    check_pin
    exit 0
    ;;
  --strict)
    [ -L "$TARGET" ] || die "not linked: $TARGET"
    STRICT=1 check_pin
    echo "certified: clean tree, safe to attribute figures to the pin"
    exit 0
    ;;
  --provenance)
    [ -L "$TARGET" ] || die "not linked: $TARGET"
    provenance
    exit 0
    ;;
  '') ;;
  *) die "unknown argument: $1 (expected --check, --strict, --provenance or --unlink)" ;;
esac

[ -d "$SIBLING" ] || die "no sibling libpetri at $SIBLING (set LIBPETRI_DIR to override)"
check_pin

if [ ! -d "$SIBLING/dist" ]; then
  echo "building the sibling's dist/ ..."
  (cd "$SIBLING" && npm run build)
fi

mkdir -p "$TS_DIR/node_modules"
if [ -d "$TARGET" ] && [ ! -L "$TARGET" ]; then
  rm -rf "$BACKUP"; mv "$TARGET" "$BACKUP"; echo "backed up the registry copy to $BACKUP"
fi
rm -f "$TARGET"
ln -s "$SIBLING" "$TARGET"
echo "linked: $TARGET -> $SIBLING"

# The link is only useful if the tree actually carries the surface. The suite's own gate
# (tests/upstream/libpetri-surface-gate.test.ts) is the authority; this is the fast check.
node --input-type=module -e "
  import { systemClock, seedToken, PrecompiledNetExecutor, Marking } from 'libpetri';
  const missing = [];
  if (typeof systemClock !== 'function') missing.push('systemClock');
  if (typeof seedToken !== 'function') missing.push('seedToken');
  if (typeof PrecompiledNetExecutor.prototype.injectNoAwait !== 'function') missing.push('injectNoAwait');
  if (typeof PrecompiledNetExecutor.prototype.snapshot !== 'function') missing.push('executor.snapshot');
  if (typeof Marking.fromSnapshot !== 'function') missing.push('Marking.fromSnapshot');
  if (missing.length) { console.error('linked tree is missing: ' + missing.join(', ')); process.exit(1); }
  console.log('surface check passed');
" 2>/dev/null || echo "warning: surface check could not run (is the sibling built?); run 'npm test' to confirm"
