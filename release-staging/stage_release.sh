#!/bin/bash
# release-staging/stage_release.sh — reproducible release staging for the
# AppOS Catalog Bundle Layout v1 (fn-167 R8).
#
# Produces release-staging/space-appos-ytdlp-<version>.zip from the repo dev
# tree (root plugin.json runtime manifest, dist/ built via ./build.sh,
# webview/, assets/, LICENSE/CHANGELOG.md/README.md) plus the tracked catalog
# manifest source release-staging/manifest.json.
#
# Canonical layout (see the desktop repo's docs/PLUGIN-DEV-GUIDE.md §2.1
# "Publishing to the catalog: bundle layout"):
#   * manifest.json (catalog manifest-v1) at zip root — the ONLY member the
#     catalog's Phase-1 candidate scan may see
#   * the AppOS runtime manifest COPIED to appos/runtime/plugin.json (depth 2,
#     invisible to the candidate scan; the desktop installer normalizes it
#     back to the plugin root at install time)
#   * NO plugin.json at zip root or one level deep
#   * runtime payload (dist/, webview/, assets/, ...) at zip root, paths
#     inside the runtime manifest relative to the zip root
#
# Usage:
#   ./release-staging/stage_release.sh [--output-dir <dir>] [--force]
#   ./release-staging/stage_release.sh --check-zip <path/to/bundle.zip>
#
# Modes:
#   default          stage + zip + self-check + place the zip
#   --output-dir D   write the zip into D instead of release-staging/ (the
#                    live published artifact stays untouched; validation runs
#                    always use --output-dir "$(mktemp -d)")
#   --force          allow overwriting an existing zip of the same version
#                    (the shipped 1.1.0 zip is live published evidence — never
#                    clobbered silently)
#   --check-zip P    run ONLY the self-check suite (catalog candidate
#                    predicate + manifest coherence + entrypoint existence)
#                    against an arbitrary existing zip. No staging, no writes.
#                    Shares the exact same checker function as the staging
#                    path, so negative tests exercise the real gate.
#
# Reproducibility:
#   The member set, member order, and layout are always deterministic. For
#   BYTE-identical zips (stable sha256 across runs/machines), set
#   SOURCE_DATE_EPOCH=<unix-seconds> — staged mtimes are normalized to it
#   before zipping (reproducible-builds.org convention). Staged member modes
#   are ALWAYS normalized (755 dirs / 644 files) before zipping, so the
#   builder's umask cannot leak into the archive bytes. The same zip
#   implementation must be used on both sides.
#
# Exit codes (explicit; nothing exits via bare failure):
#   0  success / all checks passed
#   1  usage error (unknown flag, missing argument)
#   2  missing prerequisite (required tool, unreadable zip, or a source file
#      absent from the dev tree — e.g. dist/main.js before ./build.sh)
#   3  version mismatch (root plugin.json .version != manifest.json .version,
#      or the two manifests inside a checked zip disagree)
#   4  catalog candidate-predicate violation (0 or >1 candidates, or the
#      single candidate is not root manifest.json)
#   5  runtime manifest missing at appos/runtime/plugin.json
#   6  manifest-coherence violation: catalog .entry.path != runtime .entrypoint
#   7  entrypoint file missing from the staged tree (zip has no member at the
#      path the manifests reference)
#   8  refusing to overwrite an existing zip without --force
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ---------------------------------------------------------------------------
# Canonical AppOS Catalog Bundle Layout v1 — the 21 FILE member paths.
#
# SINGLE SOURCE OF TRUTH parity: the AppOS desktop repo pins this same array
# as `canonicalSeedFileMembers` in
#   Tests/TwoPanezTests/Store/CatalogBundleLayoutParityTests.swift
# where the R7 parity guard and the R1 E2E install fixture both consume it.
# Keep the two lists in lockstep — drift breaks the desktop parity test
# before it breaks a live publish.
#
# Directory entries (dist/, webview/, appos/, appos/runtime/, assets/, ...)
# are deliberately absent: they never match the catalog candidate predicate
# and `zip` only emits entries for the file paths named here.
# ---------------------------------------------------------------------------
CANONICAL_FILE_MEMBERS=(
    "LICENSE"
    "CHANGELOG.md"
    "dist/main.js"
    "webview/library/index.html"
    "webview/library/styles.css"
    "webview/library/app.js"
    "webview/shared/styles.css"
    "webview/shared/bridge.js"
    "webview/shared/ui-helpers.js"
    "webview/shared/degraded-banner.js"
    "webview/shared/messages.js"
    "webview/download/index.html"
    "webview/download/switch.js"
    "webview/download/styles.css"
    "webview/download/queue.js"
    "webview/download/form.js"
    "README.md"
    "appos/runtime/plugin.json"
    "manifest.json"
    "assets/icon.png"
    "assets/README.md"
    # NOTE: screenshot members intentionally absent — real GUI captures are a
    # tracked maintainer task and placeholders must never be staged
    # (see assets/README.md). Re-add members here only when real captures land,
    # and update canonicalSeedFileMembers in the desktop repo in lockstep.
)

RUNTIME_MANIFEST_MEMBER="appos/runtime/plugin.json"

usage() {
    # Print the header comment block (everything up to `set -euo pipefail`).
    awk 'NR == 1 { next } /^set -euo pipefail/ { exit } { sub(/^# ?/, ""); print }' \
        "${BASH_SOURCE[0]}"
}

log() { printf '%s\n' "$*"; }

fail() {
    # fail <exit-code> <message...>
    local code="$1"
    shift
    printf 'FAIL(%s): %s\n' "$code" "$*" >&2
    exit "$code"
}

require_tools() {
    local tool
    for tool in python3 zip zipinfo unzip shasum; do
        command -v "$tool" >/dev/null 2>&1 \
            || fail 2 "required tool not found: $tool"
    done
}

# json_field <file> <dotted.path> — print a JSON field; exits 2 (from python)
# on absent path or unparsable JSON. Callers attach context via `|| fail`.
json_field() {
    python3 - "$1" "$2" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        v = json.load(f)
    for key in sys.argv[2].split("."):
        v = v[key]
except (KeyError, TypeError, ValueError, OSError):
    sys.exit(2)
print(v)
PY
}

# ---------------------------------------------------------------------------
# check_zip <zip-path> — the R8 self-check suite. THE one checker: both the
# staging flow and --check-zip mode call this exact function, so negative
# tests against mutated zips exercise the same gate the release path uses.
# ---------------------------------------------------------------------------
check_zip() {
    local zip_path="$1"
    [ -f "$zip_path" ] || fail 2 "zip not found: $zip_path"

    local members
    members="$(zipinfo -1 "$zip_path")" \
        || fail 2 "unable to list members of ${zip_path} (not a zip?)"

    # -- Check 1: catalog Phase-1 candidate predicate ----------------------
    # Transcribed from AgentService vendor/catalog-service/src/routes/
    # publish.ts:363-365 (origin/main f702801):
    #
    #     /^(?:[^\/]+\/)?(?:plugin|manifest)\.json$/.test(entry.name) &&
    #         (entry.name.match(/\//g) ?? []).length <= 1
    #
    # i.e. a member named plugin.json OR manifest.json at the zip root or
    # exactly one directory level deep. 0 candidates -> HTTP 400 no_manifest;
    # >1 -> HTTP 400 ambiguous_bundle_root. The regex alone already admits at
    # most one slash; the awk depth re-check is kept for 1:1 fidelity with
    # the TS source's explicit slash-count clause.
    local candidates
    candidates="$(printf '%s\n' "$members" \
        | grep -E '^([^/]+/)?(plugin|manifest)\.json$' \
        | awk -F'/' 'NF <= 2' || true)"

    local candidate_count
    candidate_count="$(printf '%s' "$candidates" | grep -c . || true)"

    if [ "$candidate_count" -ne 1 ]; then
        [ -n "$candidates" ] && printf 'candidates found:\n%s\n' "$candidates" >&2
        fail 4 "expected exactly ONE catalog manifest candidate, found ${candidate_count} (publish would 400 no_manifest / ambiguous_bundle_root)"
    fi
    if [ "$candidates" != "manifest.json" ]; then
        fail 4 "the single catalog candidate must be root manifest.json, found: ${candidates}"
    fi
    log "[check] candidate predicate: exactly one candidate == manifest.json"

    # -- Check 2: runtime manifest at the well-known depth-2 path ----------
    printf '%s\n' "$members" | grep -qxF "$RUNTIME_MANIFEST_MEMBER" \
        || fail 5 "runtime manifest missing at ${RUNTIME_MANIFEST_MEMBER}"
    log "[check] runtime manifest present at ${RUNTIME_MANIFEST_MEMBER}"

    # -- Check 3: manifest coherence ---------------------------------------
    # Cross-checked fields: version equality and catalog .entry.path ==
    # runtime .entrypoint (both dist/main.js today), plus entrypoint member
    # existence. Other fields (slug/title/description/...) are intentionally
    # NOT cross-checked — they have no runtime counterpart with identical
    # semantics (catalog `slug` is a store handle, runtime `id` is a reverse-
    # DNS plugin id; `title`/`name` and the two `description`s legitimately
    # diverge per surface).
    local extract_dir
    extract_dir="$(mktemp -d "${WORK_TMP}/check.XXXXXX")" \
        || fail 2 "mktemp failed for manifest extraction"

    unzip -p "$zip_path" manifest.json > "${extract_dir}/manifest.json" \
        || fail 2 "unable to extract manifest.json from ${zip_path}"
    unzip -p "$zip_path" "$RUNTIME_MANIFEST_MEMBER" > "${extract_dir}/plugin.json" \
        || fail 2 "unable to extract ${RUNTIME_MANIFEST_MEMBER} from ${zip_path}"

    local catalog_version runtime_version
    catalog_version="$(json_field "${extract_dir}/manifest.json" version)" \
        || fail 2 "manifest.json inside zip has no .version"
    runtime_version="$(json_field "${extract_dir}/plugin.json" version)" \
        || fail 2 "runtime plugin.json inside zip has no .version"
    if [ "$catalog_version" != "$runtime_version" ]; then
        fail 3 "version mismatch inside zip: catalog manifest.json=${catalog_version} runtime plugin.json=${runtime_version}"
    fi
    log "[check] versions coherent: ${catalog_version}"

    local entry_path entrypoint
    entry_path="$(json_field "${extract_dir}/manifest.json" entry.path)" \
        || fail 2 "manifest.json inside zip has no .entry.path"
    entrypoint="$(json_field "${extract_dir}/plugin.json" entrypoint)" \
        || fail 2 "runtime plugin.json inside zip has no .entrypoint"
    if [ "$entry_path" != "$entrypoint" ]; then
        fail 6 "entry mismatch: catalog .entry.path=${entry_path} != runtime .entrypoint=${entrypoint}"
    fi
    log "[check] catalog .entry.path == runtime .entrypoint (${entry_path})"

    printf '%s\n' "$members" | grep -qxF "$entrypoint" \
        || fail 7 "entrypoint file ${entrypoint} is not a member of the staged zip"
    log "[check] entrypoint member exists in staged tree (${entrypoint})"

    log "SELF-CHECK PASS: ${zip_path}"
    return 0
}

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------
OUTPUT_DIR="$SCRIPT_DIR"
FORCE=0
CHECK_ZIP_PATH=""

while [ $# -gt 0 ]; do
    case "$1" in
        --output-dir)
            [ $# -ge 2 ] || fail 1 "--output-dir requires a directory argument"
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --force)
            FORCE=1
            shift
            ;;
        --check-zip)
            [ $# -ge 2 ] || fail 1 "--check-zip requires a zip path argument"
            CHECK_ZIP_PATH="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail 1 "unknown argument: $1 (see --help)"
            ;;
    esac
done

require_tools

# Single scratch root + single EXIT trap for every temp artifact (check
# extraction dirs, staging tree, pre-placement zip).
WORK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/stage-release.XXXXXX")" \
    || fail 2 "mktemp failed"
trap 'rm -rf "$WORK_TMP"' EXIT

# --check-zip mode: checks only, no staging, no writes.
if [ -n "$CHECK_ZIP_PATH" ]; then
    check_zip "$CHECK_ZIP_PATH"
    exit 0
fi

# ---------------------------------------------------------------------------
# staging flow
# ---------------------------------------------------------------------------
CATALOG_MANIFEST_SRC="${SCRIPT_DIR}/manifest.json"
RUNTIME_MANIFEST_SRC="${REPO_ROOT}/plugin.json"

[ -f "$CATALOG_MANIFEST_SRC" ] \
    || fail 2 "catalog manifest source missing: ${CATALOG_MANIFEST_SRC}"
[ -f "$RUNTIME_MANIFEST_SRC" ] \
    || fail 2 "runtime manifest missing: ${RUNTIME_MANIFEST_SRC}"

VERSION="$(json_field "$RUNTIME_MANIFEST_SRC" version)" \
    || fail 2 "plugin.json has no .version"
CATALOG_VERSION="$(json_field "$CATALOG_MANIFEST_SRC" version)" \
    || fail 2 "release-staging/manifest.json has no .version"
if [ "$VERSION" != "$CATALOG_VERSION" ]; then
    fail 3 "version mismatch: plugin.json=${VERSION} release-staging/manifest.json=${CATALOG_VERSION} — update both before staging"
fi

OUT_ZIP="${OUTPUT_DIR}/space-appos-ytdlp-${VERSION}.zip"
if [ -e "$OUT_ZIP" ] && [ "$FORCE" -ne 1 ]; then
    fail 8 "refusing to overwrite existing ${OUT_ZIP} (live artifacts are published evidence) — pass --force to allow, or --output-dir to write elsewhere"
fi

STAGE_DIR="${WORK_TMP}/stage"
mkdir -p "$STAGE_DIR" || fail 2 "unable to create staging dir ${STAGE_DIR}"

log "staging AppOS Catalog Bundle Layout v1 for space-appos-ytdlp ${VERSION}"
for member in "${CANONICAL_FILE_MEMBERS[@]}"; do
    case "$member" in
        manifest.json)
            src="$CATALOG_MANIFEST_SRC"
            ;;
        "$RUNTIME_MANIFEST_MEMBER")
            # The dev-layout root plugin.json rides at depth 2 in the bundle —
            # invisible to the catalog candidate scan; the desktop installer
            # copies it back to the plugin root at install time.
            src="$RUNTIME_MANIFEST_SRC"
            ;;
        *)
            src="${REPO_ROOT}/${member}"
            ;;
    esac
    if [ ! -f "$src" ]; then
        hint=""
        case "$member" in
            dist/*) hint=" (run ./build.sh first)" ;;
        esac
        fail 2 "source file missing for bundle member ${member}: ${src}${hint}"
    fi
    mkdir -p "${STAGE_DIR}/$(dirname "$member")" \
        || fail 2 "unable to create staging subdir for ${member}"
    cp "$src" "${STAGE_DIR}/${member}" \
        || fail 2 "unable to copy ${src} -> staged ${member}"
done

# Mode-reproducibility: `cp` creates staged files with umask-dependent
# permission bits, and Info-ZIP records them in the central directory even
# with -X, so identical content staged under different umasks (e.g. 022 vs
# 077) would zip to different bytes / sha256. Normalize the staged tree
# unconditionally: 755 dirs, 644 files. No canonical member is executable
# (JS/JSON/HTML/CSS/PNG/MD payload — nothing is spawned as a binary), so a
# blanket 644 is correct; if a future member ever needs +x, chmod it 755
# explicitly BY NAME here so the result stays deterministic.
find "$STAGE_DIR" -type d -exec chmod 755 {} + \
    || fail 2 "unable to normalize staged directory modes"
find "$STAGE_DIR" -type f -exec chmod 644 {} + \
    || fail 2 "unable to normalize staged file modes"
log "normalized staged modes (dirs 755, files 644)"

# Byte-reproducibility: `cp` stamps fresh mtimes and zip records them, so two
# stagings of identical content would otherwise differ. With SOURCE_DATE_EPOCH
# set (the reproducible-builds convention), every staged member is normalized
# to that timestamp before zipping — same content + same SOURCE_DATE_EPOCH +
# same zip implementation => byte-identical zip / stable sha256. Without it,
# reproducibility is layout-level (deterministic member set + order), not
# byte-level.
if [ -n "${SOURCE_DATE_EPOCH:-}" ]; then
    SDE_STAMP="$(date -u -r "$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S 2>/dev/null \
        || date -u -d "@$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S 2>/dev/null)" \
        || fail 1 "invalid SOURCE_DATE_EPOCH: ${SOURCE_DATE_EPOCH}"
    TZ=UTC find "$STAGE_DIR" -type f -exec touch -t "$SDE_STAMP" {} + \
        || fail 2 "unable to normalize staged mtimes"
    log "normalized staged mtimes to SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}"
fi

TMP_ZIP="${WORK_TMP}/space-appos-ytdlp-${VERSION}.zip"
# -X strips platform extra fields (uid/gid/timestamps beyond DOS mtime); the
# member order is the canonical array — both keep the archive deterministic.
(cd "$STAGE_DIR" && TZ=UTC zip -q -X "$TMP_ZIP" "${CANONICAL_FILE_MEMBERS[@]}") \
    || fail 2 "zip creation failed"

# Self-check BEFORE the zip lands anywhere a publish flow could pick it up.
check_zip "$TMP_ZIP"

mkdir -p "$OUTPUT_DIR" || fail 2 "unable to create output dir ${OUTPUT_DIR}"
mv "$TMP_ZIP" "$OUT_ZIP" || fail 2 "unable to place zip at ${OUT_ZIP}"

SHA256="$(shasum -a 256 "$OUT_ZIP" | awk '{print $1}')" \
    || fail 2 "unable to checksum ${OUT_ZIP}"
log "staged: ${OUT_ZIP}"
log "sha256: ${SHA256}"
log "members: ${#CANONICAL_FILE_MEMBERS[@]} files (canonical layout)"
exit 0
