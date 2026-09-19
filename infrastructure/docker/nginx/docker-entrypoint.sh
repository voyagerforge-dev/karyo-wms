#!/bin/sh
set -e

# Log the KEYCLOAK_URL value for diagnostics
echo "[nginx-entrypoint] KEYCLOAK_URL=${KEYCLOAK_URL:-UNSET}"

# Replace ${KEYCLOAK_URL} in the SPA index.html
envsubst '${KEYCLOAK_URL}' < /usr/share/nginx/html/index.html.template > /usr/share/nginx/html/index.html

# Fail fast if substitution did not work
if grep -q '${KEYCLOAK_URL}' /usr/share/nginx/html/index.html; then
  echo "[nginx-entrypoint] ERROR: KEYCLOAK_URL was not substituted. Check env_file." >&2
  exit 1
fi
echo "[nginx-entrypoint] KEYCLOAK_URL substituted successfully"

# Floor PWA: inject KEYCLOAK_URL into the mobile SPA index.html
envsubst '${KEYCLOAK_URL}' < /usr/share/nginx/html/m/index.html.template > /usr/share/nginx/html/m/index.html
if grep -q '${KEYCLOAK_URL}' /usr/share/nginx/html/m/index.html; then
  echo "[nginx-entrypoint] ERROR: KEYCLOAK_URL not substituted in /m." >&2
  exit 1
fi

# --- Upstream DNS resolver ---
#
# nginx.conf marks the karyo-app and keycloak upstreams `resolve` so that recreating one of those
# containers -- which gives it a NEW address on the Compose network -- is picked up on its own,
# without reloading nginx (see the "Upstream DNS resolution" comment in nginx.conf). `resolve`
# needs a `resolver`, and its address differs by runtime: Docker's embedded DNS answers on
# 127.0.0.11, while Podman (aardvark-dns) answers on the network gateway, whose address varies per
# network. Rather than hard-code either, read the nameserver(s) the runtime itself wrote into this
# container's /etc/resolv.conf and render the `resolver` directive that nginx.conf includes.
resolvers=$(awk '/^[[:space:]]*nameserver/ && $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { print $2 }' /etc/resolv.conf | tr '\n' ' ' | sed 's/[[:space:]]*$//')
if [ -z "$resolvers" ]; then
  echo "[nginx-entrypoint] ERROR: no IPv4 nameserver in /etc/resolv.conf; cannot enable upstream re-resolution." >&2
  exit 1
fi
printf 'resolver %s ipv6=off valid=10s;\n' "$resolvers" > /etc/nginx/resolver.conf
echo "[nginx-entrypoint] upstream resolver: ${resolvers} (from /etc/resolv.conf)"

# Execute the CMD (nginx)
exec "$@"
