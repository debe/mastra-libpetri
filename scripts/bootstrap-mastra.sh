#!/usr/bin/env bash
#
# Puts a pinned Mastra tree under .mastra/ (gitignored — never committed).
#
# There is no fork of Mastra and no checked-in copy of it. Everything this repository knows
# about Mastra's semantics is read from a tree this script produces, at the revision recorded
# in scripts/mastra-pin, so "we checked" is a reproducible claim rather than a memory.
#
# TWO ROUTES, because they answer different questions.
#
#   --dist  (default)  npm pack the pinned @mastra/core, extract it, and recover the ORIGINAL
#                      TypeScript from the published sourcemaps. @mastra/core ships .js.map
#                      files carrying `sourcesContent`, so the real source of the workflow
#                      engine comes out of the tarball — no monorepo clone, ~14MB, seconds.
#                      This is what the compiler is written against: it is the surface a user
#                      of this engine actually runs.
#
#   --repo             git clone the monorepo at the pinned commit. Needed ONLY for
#                      conformance, because the published package ships no tests and
#                      conformance means running Mastra's own workflow suite under both
#                      engines. Large and slow; not required to build or test this package.
#
#   --check            report what is present and whether it matches the pin.
#   --clean            remove .mastra/ entirely.
#
# The dist route verifies the tarball against the pinned sha512 before extracting, so a
# silently republished version fails loudly instead of quietly changing what we compiled for.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/.mastra"
PIN_FILE="$REPO_ROOT/scripts/mastra-pin"

die() { printf '%s\n' "error: $*" >&2; exit 1; }
note() { printf '%s\n' "$*" >&2; }

[ -f "$PIN_FILE" ] || die "missing $PIN_FILE"
# shellcheck disable=SC1090
. "$PIN_FILE"
[ -n "${MASTRA_DIST_VERSION:-}" ] || die "MASTRA_DIST_VERSION unset in $PIN_FILE"

TARBALL="$DEST/mastra-core-$MASTRA_DIST_VERSION.tgz"
PKG_DIR="$DEST/package"
SRC_DIR="$DEST/src-extracted"

verify_integrity() {
  local file="$1" want="${MASTRA_DIST_INTEGRITY:-}"
  [ -n "$want" ] || { note "note: no MASTRA_DIST_INTEGRITY pinned; skipping verification"; return 0; }
  local have
  have="sha512-$(openssl dgst -sha512 -binary "$file" | openssl base64 -A)"
  [ "$have" = "$want" ] || die "tarball integrity mismatch
  pinned:   $want
  computed: $have
A republished version is not the version this repository was written against. Update
scripts/mastra-pin deliberately, and re-run every measurement taken against the old one."
  note "integrity ok ($MASTRA_DIST_VERSION)"
}

# Recovers the original TypeScript from the sourcemaps shipped in the package. Writes only
# files that do not already exist, so the first map to carry a source wins and the walk is
# order-independent.
extract_sources() {
  node -e '
    const fs = require("fs"), path = require("path");
    const [pkgDir, outDir] = process.argv.slice(1);
    const maps = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js.map")) maps.push(p);
      }
    })(path.join(pkgDir, "dist"));

    let written = 0, skipped = 0;
    for (const f of maps) {
      let m;
      try { m = JSON.parse(fs.readFileSync(f, "utf8")); } catch { skipped++; continue; }
      if (!m.sourcesContent) { skipped++; continue; }
      m.sources.forEach((s, i) => {
        const content = m.sourcesContent[i];
        if (content == null) return;
        let rel = s.replace(/^(\.\.\/)+/, "").replace(/^\.\//, "");
        if (!rel.startsWith("src/")) rel = "src/" + rel;
        // Refuse anything that escapes the output directory.
        const dest = path.resolve(outDir, rel);
        if (!dest.startsWith(path.resolve(outDir) + path.sep)) return;
        if (fs.existsSync(dest)) return;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
        written++;
      });
    }
    console.log(`recovered ${written} source files from ${maps.length - skipped} sourcemaps`);
  ' "$PKG_DIR" "$SRC_DIR"
}

do_dist() {
  mkdir -p "$DEST"
  if [ ! -f "$TARBALL" ]; then
    note "fetching @mastra/core@$MASTRA_DIST_VERSION"
    (cd "$DEST" && npm pack "@mastra/core@$MASTRA_DIST_VERSION" >/dev/null)
    [ -f "$TARBALL" ] || die "npm pack did not produce $TARBALL"
  else
    note "tarball already present"
  fi
  verify_integrity "$TARBALL"

  rm -rf "$PKG_DIR" "$SRC_DIR"
  (cd "$DEST" && tar xzf "$(basename "$TARBALL")")
  [ -d "$PKG_DIR/dist/workflows" ] || die "extracted package has no dist/workflows"
  extract_sources

  # The files every semantic claim in this repository is argued from. If one of these stops
  # appearing, the recovery silently degraded to type declarations only and the next reader
  # would be reasoning from .d.ts shapes instead of behaviour.
  local required=(
    "$SRC_DIR/src/workflows/default.ts"
    "$SRC_DIR/src/workflows/execution-engine.ts"
    "$SRC_DIR/src/workflows/workflow.ts"
    "$SRC_DIR/src/workflows/handlers/control-flow.ts"
    "$SRC_DIR/src/workflows/handlers/step.ts"
    "$SRC_DIR/src/workflows/handlers/sleep.ts"
    "$SRC_DIR/src/workflows/handlers/entry.ts"
  )
  local missing=0
  for f in "${required[@]}"; do
    [ -f "$f" ] || { note "missing recovered source: ${f#"$DEST"/}"; missing=1; }
  done
  [ "$missing" -eq 0 ] || die "sourcemap recovery incomplete; the dist route is only useful with real source"
  note "ok: $(find "$SRC_DIR/src/workflows" -name '*.ts' | wc -l | tr -d ' ') workflow source files under ${SRC_DIR#"$REPO_ROOT"/}"
}

do_repo() {
  local repo_dir="$DEST/repo"
  [ -n "${MASTRA_REPO_URL:-}" ] || die "MASTRA_REPO_URL unset in $PIN_FILE"
  mkdir -p "$DEST"
  if [ ! -d "$repo_dir/.git" ]; then
    note "cloning $MASTRA_REPO_URL (this is large; only conformance needs it)"
    git clone --filter=blob:none "$MASTRA_REPO_URL" "$repo_dir"
  fi
  if [ -n "${MASTRA_REPO_COMMIT:-}" ]; then
    git -C "$repo_dir" fetch --depth=1 origin "$MASTRA_REPO_COMMIT" 2>/dev/null || git -C "$repo_dir" fetch origin
    git -C "$repo_dir" checkout --detach "$MASTRA_REPO_COMMIT"
  else
    local head
    head="$(git -C "$repo_dir" rev-parse HEAD)"
    note "no MASTRA_REPO_COMMIT pinned; checked out $head"
    note "record it: sed -i '' \"s/^MASTRA_REPO_COMMIT=.*/MASTRA_REPO_COMMIT=$head/\" scripts/mastra-pin"
  fi
  note "ok: ${repo_dir#"$REPO_ROOT"/} at $(git -C "$repo_dir" rev-parse --short HEAD)"
}

do_check() {
  local rc=0
  if [ -d "$SRC_DIR/src/workflows" ]; then
    note "dist: $MASTRA_DIST_VERSION, $(find "$SRC_DIR/src/workflows" -name '*.ts' | wc -l | tr -d ' ') recovered workflow sources"
    [ -f "$TARBALL" ] && verify_integrity "$TARBALL"
  else
    note "dist: absent — run scripts/bootstrap-mastra.sh --dist"; rc=1
  fi
  if [ -d "$DEST/repo/.git" ]; then
    note "repo: $(git -C "$DEST/repo" rev-parse --short HEAD)"
  else
    note "repo: absent — only conformance needs it (scripts/bootstrap-mastra.sh --repo)"
  fi
  return $rc
}

case "${1:---dist}" in
  --dist)  do_dist ;;
  --repo)  do_repo ;;
  --check) do_check ;;
  --clean) rm -rf "$DEST"; note "removed ${DEST#"$REPO_ROOT"/}" ;;
  *) die "unknown option '$1' (expected --dist, --repo, --check or --clean)" ;;
esac
