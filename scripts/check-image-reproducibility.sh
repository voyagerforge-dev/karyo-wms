#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Karyo WMS - the shipped images must be byte-identical when their content is
#
# WHY THIS EXISTS
#
# Every dependency jar in services/karyo-app/build/quarkus-app/lib/main/ carries the
# BUILD TIME as its mtime, not the jar's own: quarkusBuild restamps all 347 of them on
# every run. A container COPY records mtimes in the layer tar, so the 94 MiB `lib/`
# layer used to get a fresh digest on every build even when not one byte of dependency
# content had changed. Layer and blob deduplication key on that digest, so an upgrade
# re-transferred the entire payload instead of the small delta. Measured, not assumed.
#
# Two things fix it, and BOTH are needed:
#   1. `--timestamp 0` on the build, which normalises every recorded timestamp.
#   2. dropping /var/log/apk.log in the RUN that creates it (Dockerfile.service), which
#      apk stamps with the wall clock. With (1) alone that one 3.5 KB file was the only
#      difference left, and it still churned its whole 3.32 MiB layer.
# With both, two --no-cache builds of identical content produce the same IMAGE ID.
#
# WHAT THIS SCRIPT CHECKS
#
#   --audit  (default, seconds, no podman)  Each of the known build sites in
#            BUILD_SITES below is split into logical commands (backslash continuations
#            joined, comment lines dropped), and EVERY command that builds
#            Dockerfile.service or Dockerfile.nginx must carry the determinism setting
#            itself - or be a call to a helper defined in the same file whose own build
#            commands all carry it, which is how deploy-server.sh spells the two
#            runtimes. The setting is never counted file-wide: a flag elsewhere in the
#            file does not cover a build that lost its own.
#            This is a FIXED list, not tree-wide discovery. A build site in a new file
#            is not detected; adding one means adding it here.
#   --prove  (needs podman + a built fast-jar)  Actually build the application image
#            twice, restamping every lib/ mtime in between, and assert the image ID is
#            unchanged. This is the real property; the audit only guards its inputs.
#
# Usage:
#   ./scripts/check-image-reproducibility.sh            # audit
#   ./scripts/check-image-reproducibility.sh --prove    # audit, then the double build
#   ./scripts/check-image-reproducibility.sh --prove-only
# ============================================================================

MODE="audit"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --audit) MODE="audit"; shift ;;
        --prove) MODE="both"; shift ;;
        --prove-only) MODE="prove"; shift ;;
        -h|--help) sed -n '4,/^# ===/p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Script scope, not function scope: the EXIT trap that removes them outlives prove().
TAG_A="karyo-app:repro-check-a"
TAG_B="karyo-app:repro-check-b"

# The places that BUILD one of the two shipped images.
BUILD_SITES=(
    ".github/workflows/ci.yml"
    "scripts/deploy-server.sh"
    "scripts/scan-image.sh"
)

# A build of one of the images, in the `-f <path>` form every site uses.
BUILD_RE='-f[[:space:]]+infrastructure/docker/Dockerfile\.(service|nginx)'
# `--timestamp` for podman/buildah; SOURCE_DATE_EPOCH for docker BuildKit, which has no
# equivalent flag.
SETTING_RE='--timestamp|SOURCE_DATE_EPOCH'
# A `build` subcommand, used to check every build inside a helper's own body.
HELPER_BUILD_RE='(^|[[:space:]])build([[:space:]]|$)'

# One logical command per line: comment-only lines dropped, backslash continuations
# joined. Shell and YAML both spell a comment `#`.
logical_lines() {
    awk '
        { sub(/\r$/, "") }
        buf == "" && /^[[:space:]]*#/ { next }
        { line = (buf == "" ? $0 : buf " " $0) }
        line ~ /\\[[:space:]]*$/ { sub(/\\[[:space:]]*$/, "", line); buf = line; next }
        { buf = ""; print line }
        END { if (buf != "") print buf }
    '
}

# True when $2 names a function in $1 (the file's logical lines) whose every build
# command carries a determinism setting. deploy-server.sh's build_image() is the case
# this exists for: podman and docker need different spellings, so the branch belongs in
# one helper rather than duplicated at each call site.
helper_is_deterministic() {
    local lines="$1" name="$2" body builds
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
    body="$(printf '%s\n' "$lines" | awk -v fn="$name" '
        !inside {
            if ($0 ~ "^[[:space:]]*(function[[:space:]]+)?" fn "[[:space:]]*\\(\\)") inside = 1
            next
        }
        /^\}/ { inside = 0; next }
        { print }
    ')"
    builds="$(printf '%s\n' "$body" | grep -E -- "$HELPER_BUILD_RE" || true)"
    [[ -n "$builds" ]] || return 1
    ! printf '%s\n' "$builds" | grep -qvE -- "$SETTING_RE"
}

audit() {
    local failed=0

    echo "==> Auditing image build invocations"

    local f lines invocations inv cmd count bad indent
    for f in "${BUILD_SITES[@]}"; do
        if [[ ! -f "$f" ]]; then
            echo "  FAIL  $f is a declared build site but does not exist."
            failed=1
            continue
        fi

        lines="$(logical_lines <"$f")"
        invocations="$(printf '%s\n' "$lines" | grep -E -- "$BUILD_RE" || true)"
        if [[ -z "$invocations" ]]; then
            echo "  FAIL  $f no longer builds either image; the list in $0 is stale."
            failed=1
            continue
        fi

        count=0
        bad=0
        while IFS= read -r inv; do
            [[ -z "$inv" ]] && continue
            count=$((count + 1))
            grep -qE -- "$SETTING_RE" <<< "$inv" && continue
            cmd="$(awk '{ print $1; exit }' <<< "$inv")"
            helper_is_deterministic "$lines" "$cmd" && continue
            indent="${inv%%[![:space:]]*}"
            echo "  FAIL  $f: this build carries no determinism setting:"
            echo "          ${inv#"$indent"}"
            bad=1
        done <<< "$invocations"

        if [[ "$bad" -ne 0 ]]; then
            echo "        A podman build of these images needs --timestamp 0; docker"
            echo "        BuildKit has no such flag and needs SOURCE_DATE_EPOCH=0. Put it on"
            echo "        the build itself, or on every build in the helper it calls."
            failed=1
        else
            echo "  ok    $f ($count deterministic image build(s))"
        fi
    done

    if [[ "$failed" -ne 0 ]]; then
        echo
        echo "Image builds are not uniformly deterministic. See the header of $0."
        return 1
    fi
    echo "  Every image build at the known build sites carries a determinism setting."
}

prove() {
    echo "==> Proving the application image is reproducible (two --no-cache builds)"

    local jar="services/karyo-app/build/quarkus-app/quarkus-run.jar"
    if [[ ! -f "$jar" ]]; then
        echo "  Missing $jar." >&2
        echo "  Run: ./gradlew :services:karyo-app:quarkusBuild -Dquarkus.profile=prod" >&2
        return 1
    fi

    # NOT `local`: the EXIT trap below fires after this function has returned, when a
    # local is already out of scope, and `set -u` then kills the script with "tag_a:
    # unbound variable" AFTER it has printed a pass. Measured - it turned a green proof
    # into a red step.
    #
    # `rmi`, never `rmi -f`. When this runs in CI right after the package job built
    # karyo-app:<sha> from the same tree, the fix under test makes all three THE SAME
    # image with three names, and `-f` would delete the image out from under the
    # publish and scan steps. Plain rmi on a multi-named image only drops that name.
    # shellcheck disable=SC2317
    cleanup() { podman rmi "$TAG_A" "$TAG_B" >/dev/null 2>&1 || true; }
    trap cleanup EXIT

    build_once() {
        # --no-cache is the point: a cache hit would return the first build's layer and
        # prove nothing. --timestamp 0 is the setting under test.
        podman build --no-cache --timestamp 0 \
            -f infrastructure/docker/Dockerfile.service \
            --build-arg SERVICE_DIR=services/karyo-app \
            --build-arg "IMAGE_LICENSES=$(cat services/karyo-app/build/image-licenses)" \
            -t "$1" . >/dev/null
    }

    build_once "$TAG_A"

    # Restamp every lib/ mtime. This is exactly what quarkusBuild does to all 347 jars on
    # the next run, compressed into one command, and it is the input that used to change
    # the layer digest. Without it the two builds would be trivially identical and the
    # check would pass while proving nothing.
    find services/karyo-app/build/quarkus-app/lib -type f -print0 \
        | xargs -0 -n 200 touch -d "1999-12-31 23:59:59"

    build_once "$TAG_B"

    local id_a id_b
    id_a="$(podman image inspect "$TAG_A" --format '{{.Id}}')"
    id_b="$(podman image inspect "$TAG_B" --format '{{.Id}}')"

    echo "  build 1: sha256:$id_a"
    echo "  build 2: sha256:$id_b"

    if [[ "$id_a" != "$id_b" ]]; then
        echo
        echo "  FAIL  identical content produced two different images."
        echo "  Differing layers (diff IDs, build 1 vs build 2):"
        diff <(podman image inspect "$TAG_A" --format '{{json .RootFS.Layers}}' | tr ',' '\n') \
             <(podman image inspect "$TAG_B" --format '{{json .RootFS.Layers}}' | tr ',' '\n') || true
        echo
        echo "  Find the layer's instruction with:"
        echo "    podman image inspect $TAG_A --format '{{json .History}}'"
        return 1
    fi

    echo "  Identical. Layer deduplication holds; an upgrade transfers only what changed."
}

case "$MODE" in
    audit) audit ;;
    prove) prove ;;
    both)  audit && echo && prove ;;
esac
