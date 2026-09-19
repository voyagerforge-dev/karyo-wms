#!/bin/sh
set -e

# --- Upstream DNS resolver ---
#
# nginx.conf marks the karyo-app and keycloak upstreams `resolve` so that recreating one of those
# containers -- which gives it a NEW address on the Compose network -- is picked up on its own,
# without reloading nginx (see the "Upstream DNS resolution" comment in nginx.conf). `resolve`
# needs a `resolver`, and its address differs by runtime: Docker's embedded DNS answers on
# 127.0.0.11, while Podman (aardvark-dns) answers on the network gateway, whose address varies per
# network. Rather than hard-code either, read the IPv4 nameserver(s) the runtime itself wrote into
# this container's resolv.conf and render the `resolver` directive that nginx.conf includes.
#
# Usage: render-resolver.sh [resolv.conf] [resolver.conf]
# Defaults: /etc/resolv.conf and /etc/nginx/resolver.conf (the file nginx.conf includes).

resolv_conf=${1:-/etc/resolv.conf}
resolver_conf=${2:-/etc/nginx/resolver.conf}

resolvers=$(awk '$1 == "nameserver" && $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ { printf "%s%s", sep, $2; sep = " " }' "$resolv_conf")
if [ -z "$resolvers" ]; then
  echo "[nginx-entrypoint] ERROR: no IPv4 nameserver in ${resolv_conf}; cannot enable upstream re-resolution." >&2
  exit 1
fi
printf 'resolver %s ipv6=off valid=10s;\n' "$resolvers" > "$resolver_conf"
echo "[nginx-entrypoint] upstream resolver: ${resolvers} (from ${resolv_conf})"
