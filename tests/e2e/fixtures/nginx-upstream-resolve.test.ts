import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";

/**
 * Regression coverage for the reverse proxy's upstream DNS resolution
 * (infrastructure/docker/nginx/nginx.conf and render-resolver.sh, run by its docker-entrypoint.sh).
 *
 * Recreating the application or Keycloak container - a routine upgrade step - gives it a new
 * address on the Compose network. nginx resolves a static `upstream` server name only once, at
 * worker start-up, so before this behavior existed every `/api/` request 502'd against the dead
 * address until nginx itself was recreated. The fix marks the upstream servers `resolve` (with an
 * upstream `zone` and a `resolver` rendered from the container's own /etc/resolv.conf, because its
 * address differs between Docker and Podman).
 *
 * The resolver half runs the real render-resolver.sh through `sh` against representative
 * resolv.conf files and asserts the file it writes and its fail-closed exit. The nginx.conf half
 * parses the configuration into a directive tree and asserts what nginx does with it: every
 * proxied host is an upstream whose servers re-resolve, each zone meets nginx's 8-page minimum
 * even on a 64 KiB-page host, and the rendered resolver is included in the `http` context.
 */
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const nginxConfPath = join(repoRoot, "infrastructure/docker/nginx/nginx.conf");
const renderResolverPath = join(repoRoot, "infrastructure/docker/nginx/render-resolver.sh");

/** nginx rejects an upstream zone smaller than 8 memory pages; 64 KiB pages are the largest. */
const MIN_PORTABLE_ZONE_BYTES = 8 * 64 * 1024;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "karyo-nginx-"));
  tempDirs.push(dir);
  return dir;
}

/** Runs the real render-resolver.sh on `resolvConf`, writing to a fresh temporary output path. */
function renderResolver(resolvConf: string) {
  const dir = makeTempDir();
  const input = join(dir, "resolv.conf");
  const output = join(dir, "resolver.conf");
  writeFileSync(input, resolvConf);
  const run = spawnSync("sh", [renderResolverPath, input, output], { encoding: "utf8" });
  return { run, output };
}

type Directive = { name: string; args: string[]; block?: Directive[] };

/** Parses nginx configuration text into a directive tree (comments dropped, quotes removed). */
function parseNginxConf(text: string): Directive[] {
  const tokenPattern = /\s+|#[^\n]*|"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([;{}])|([^\s;{}"'#][^\s;{}]*)/y;
  const tokens: { value: string; punct: boolean }[] = [];
  let offset = 0;
  while (offset < text.length) {
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(text);
    assert.ok(match !== null, `cannot tokenize nginx configuration at offset ${offset}`);
    offset = tokenPattern.lastIndex;
    const [, doubleQuoted, singleQuoted, punct, word] = match;
    const value = doubleQuoted ?? singleQuoted ?? punct ?? word;
    if (value !== undefined) tokens.push({ value, punct: punct !== undefined });
  }

  let pos = 0;
  function parseBlock(nested: boolean): Directive[] {
    const directives: Directive[] = [];
    let words: string[] = [];
    while (pos < tokens.length) {
      const token = tokens[pos++];
      if (!token.punct) {
        words.push(token.value);
        continue;
      }
      if (token.value === "}") {
        assert.ok(nested && words.length === 0, "unbalanced '}' in nginx configuration");
        return directives;
      }
      assert.ok(words.length > 0, `'${token.value}' without a directive name`);
      const [name, ...args] = words;
      words = [];
      directives.push(token.value === "{" ? { name, args, block: parseBlock(true) } : { name, args });
    }
    assert.ok(!nested && words.length === 0, "unterminated nginx configuration");
    return directives;
  }
  return parseBlock(false);
}

function children(directives: Directive[], name: string): Directive[] {
  return directives.filter((directive) => directive.name === name);
}

function descendants(directives: Directive[]): Directive[] {
  return directives.flatMap((directive) => [directive, ...descendants(directive.block ?? [])]);
}

/** Converts an nginx size (`512k`, `1m`, `1048576`) to bytes. */
function sizeInBytes(size: string): number {
  const multipliers: Record<string, number> = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  const match = /^(\d+)([kKmMgG]?)$/.exec(size);
  assert.ok(match !== null, `'${size}' is not an nginx size`);
  return Number(match[1]) * multipliers[match[2].toLowerCase()];
}

type Upstream = { zoneBytes: number | null; servers: { address: string; params: string[] }[] };

function upstreams(http: Directive[]): Map<string, Upstream> {
  return new Map(
    children(http, "upstream").map((upstream): [string, Upstream] => {
      const body = upstream.block ?? [];
      const zoneSize = children(body, "zone")[0]?.args[1];
      return [
        upstream.args[0],
        {
          zoneBytes: zoneSize === undefined ? null : sizeInBytes(zoneSize),
          servers: children(body, "server").map(({ args: [address, ...params] }) => ({ address, params })),
        },
      ];
    }),
  );
}

/** Hosts that `proxy_pass http://<host>[/path]` sends traffic to, anywhere in the `http` context. */
function proxiedHosts(http: Directive[]): Set<string> {
  return new Set(
    children(descendants(http), "proxy_pass").map(({ args: [target] }) => {
      const match = /^https?:\/\/([^/]+)/.exec(target);
      assert.ok(match !== null, `unexpected proxy_pass target '${target}'`);
      return match[1];
    }),
  );
}

describe("render-resolver.sh (infrastructure/docker/nginx)", () => {
  const cases: { label: string; resolvConf: string; expected: string }[] = [
    {
      label: "Docker embedded DNS",
      resolvConf: [
        "# Generated by Docker Engine.",
        "# nameserver 192.0.2.1",
        "",
        "nameserver 127.0.0.11",
        "search example.com",
        "options edns0 trust-ad ndots:0",
        "",
        "# ExtServers: [host(127.0.0.53)]",
        "",
      ].join("\n"),
      expected: "resolver 127.0.0.11 ipv6=off valid=10s;\n",
    },
    {
      label: "Podman aardvark-dns on the network gateway",
      resolvConf: "search dns.podman\nnameserver 10.89.0.1\n",
      expected: "resolver 10.89.0.1 ipv6=off valid=10s;\n",
    },
    {
      label: "an extra IPv6 nameserver, which is dropped",
      resolvConf: "nameserver 127.0.0.11\nnameserver fe80::1\n",
      expected: "resolver 127.0.0.11 ipv6=off valid=10s;\n",
    },
    {
      label: "several IPv4 nameservers, which are joined",
      resolvConf: "nameserver 10.89.0.1\nnameserver 8.8.8.8\nnameserver 2001:db8::53\nnameserver 1.1.1.1\n",
      expected: "resolver 10.89.0.1 8.8.8.8 1.1.1.1 ipv6=off valid=10s;\n",
    },
  ];

  for (const testCase of cases) {
    it(`writes the nginx resolver for ${testCase.label}`, () => {
      const { run, output } = renderResolver(testCase.resolvConf);
      assert.equal(run.status, 0, `render-resolver.sh failed: ${run.stderr}`);
      assert.equal(readFileSync(output, "utf8"), testCase.expected);
    });
  }

  it("fails closed, writing nothing, when resolv.conf has no IPv4 nameserver", () => {
    const { run, output } = renderResolver("search dns.podman\nnameserver ::1\n");
    assert.notEqual(run.status, 0, "render-resolver.sh must fail without an IPv4 nameserver");
    assert.match(run.stderr, /no IPv4 nameserver/);
    assert.equal(existsSync(output), false, "no resolver.conf may be written");
  });
});

describe("nginx upstream re-resolution (infrastructure/docker/nginx/nginx.conf)", () => {
  const httpBlocks = children(parseNginxConf(readFileSync(nginxConfPath, "utf8")), "http");
  assert.equal(httpBlocks.length, 1, "nginx.conf must have exactly one http block");
  const http = httpBlocks[0].block ?? [];
  const upstreamsByName = upstreams(http);

  it("proxies the application and Keycloak only through named upstreams", () => {
    const hosts = proxiedHosts(http);
    assert.ok(hosts.has("karyo-app") && hosts.has("keycloak"), `proxied hosts: ${[...hosts].join(", ")}`);
    for (const host of hosts) {
      assert.ok(upstreamsByName.has(host), `proxy_pass host '${host}' must be an upstream block`);
    }
  });

  for (const [name, upstream] of upstreamsByName) {
    it(`re-resolves every '${name}' server at runtime from a zone that fits any page size`, () => {
      assert.ok(upstream.servers.length > 0, `'upstream ${name}' must have a server`);
      for (const server of upstream.servers) {
        assert.ok(server.params.includes("resolve"), `'${server.address}' in '${name}' must be 'resolve'`);
      }
      assert.ok(upstream.zoneBytes !== null, `'upstream ${name}' needs a sized zone for 'resolve'`);
      assert.ok(
        upstream.zoneBytes >= MIN_PORTABLE_ZONE_BYTES,
        `'upstream ${name}' zone is ${upstream.zoneBytes} bytes; nginx refuses to start below ` +
          `${MIN_PORTABLE_ZONE_BYTES} on a 64 KiB-page host`,
      );
    });
  }

  it("includes the rendered resolver in the http context", () => {
    const includes = children(http, "include").map(({ args: [path] }) => path);
    assert.ok(includes.includes("/etc/nginx/resolver.conf"), "http must include /etc/nginx/resolver.conf");
  });
});
