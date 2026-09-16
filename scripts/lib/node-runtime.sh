#!/usr/bin/env bash
# ============================================================================
# Karyo WMS - shared Node.js runtime preflight
#
# Single source of truth for the supported Node.js line. The repo root .nvmrc
# ("24") is the one declaration; nvm and CI's setup-node (node-version-file)
# read it directly, and this library reads it for the operator scripts so the
# deploy and E2E preflights accept exactly the declared major and no other.
#
# karyo_required_node_major prints the declared major, failing closed on a
# missing or malformed declaration. karyo_require_node fails unless the node on
# the PATH reports a vMAJOR.MINOR.PATCH version whose major equals the declared
# line; missing node, unreadable versions and future majors are all rejections.
#
# Mirrors that cannot read .nvmrc stay aligned through other means and are
# proven by tests/e2e/fixtures/node-runtime-preflight.test.ts: the package
# manifests and lockfile roots declare engines.node ^24.0.0, the three .npmrc
# files set engine-strict=true so `npm ci` refuses another line, and the nginx
# builder stages use node:24-alpine.
# ============================================================================

# Resolve the repository root from this file's own location so the library works
# however it is sourced (relative path, absolute path or symlinked consumer). The
# library lives at <root>/scripts/lib/, so the root is two levels up from its dir.
_NODE_RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_PROJECT_ROOT="$(cd "$_NODE_RUNTIME_DIR/../.." && pwd)"

# Uses the caller's log_err when defined (both operator scripts define one);
# falls back to a plain stderr line for standalone use. Always succeeds so the
# caller's flow keeps control of the exit code.
_node_runtime_err() {
    if declare -F log_err >/dev/null 2>&1; then
        log_err "$*" || true
    else
        printf '%s\n' "$*" >&2 || true
    fi
    return 0
}

# Prints the required Node.js major ("24") to stdout. The declaration is read
# from the repo root .nvmrc, resolved from this file's own location, so there is
# exactly one declaration and no environment override can shadow it.
# Fails closed: a missing file or anything but a bare integer is an error.
karyo_required_node_major() {
    local nvmrc="$_PROJECT_ROOT/.nvmrc"
    local declared
    if [ ! -f "$nvmrc" ]; then
        _node_runtime_err "Node version declaration not found: $nvmrc. Declare the supported major once in .nvmrc and re-run."
        return 1
    fi
    declared=$(tr -d '[:space:]' < "$nvmrc")
    if ! [[ "$declared" =~ ^[0-9]+$ ]]; then
        _node_runtime_err "Node version declaration in $nvmrc is not a bare integer ('${declared:-empty}'); .nvmrc must contain the supported major, e.g. 24."
        return 1
    fi
    printf '%s\n' "$declared"
}

# Fails unless node reports a supported release: a vN.M.P string whose major
# equals the declared line. Unreadable versions, a missing node and a
# missing/malformed declaration are all hard failures.
karyo_require_node() {
    local raw major declared
    if ! command -v node &>/dev/null; then
        _node_runtime_err "Node.js not found. This project supports only Node $(karyo_required_node_major 2>/dev/null || printf '?').x (see .nvmrc); install the supported line and re-run."
        return 1
    fi
    raw=$(node --version 2>/dev/null || true)
    if ! [[ "$raw" =~ ^v([0-9]+)\.[0-9]+\.[0-9]+$ ]]; then
        _node_runtime_err "Node version unreadable${raw:+ (got: $raw)}. This project supports only Node $(karyo_required_node_major 2>/dev/null || printf '?').x (see .nvmrc); expected a vMAJOR.MINOR.PATCH version."
        return 1
    fi
    major=${BASH_REMATCH[1]}
    declared=$(karyo_required_node_major) || return 1
    if [ "$major" -ne "$declared" ]; then
        _node_runtime_err "Node $raw is not supported: this project supports only Node ${declared}.x (see .nvmrc). Install the supported line and re-run."
        return 1
    fi
}
