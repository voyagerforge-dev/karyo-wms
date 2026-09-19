import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";

/**
 * Regression coverage for the reverse proxy's upstream DNS resolution
 * (infrastructure/docker/nginx/nginx.conf and its docker-entrypoint.sh).
 *
 * Recreating the application or Keycloak container - a routine upgrade step - gives it a new
 * address on the Compose network. nginx resolves a static `upstream` server name only once, at
 * worker start-up, so before this behavior existed every `/api/` request 502'd against the dead
 * address until nginx itself was recreated. The fix marks the upstream servers `resolve` (with an
 * upstream `zone` and a `resolver` whose address the entrypoint reads from the container's own
 * /etc/resolv.conf, because it differs between Docker and Podman). These assertions guard both
 * halves: that nginx.conf keeps re-resolving its upstreams, and that the entrypoint still renders
 * a resolver from whatever nameserver either runtime provides.
 *
 * The entrypoint half is behavioral, not textual: the actual `awk` program is lifted out of the
 * script and run against representative Docker and Podman resolv.conf files, so a change that
 * breaks nameserver extraction fails here even if the surrounding script still looks right.
 */
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const nginxConfPath = "infrastructure/docker/nginx/nginx.conf";
const entrypointPath = "infrastructure/docker/nginx/docker-entrypoint.sh";

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

/** Returns the body between `upstream <name> {` and its closing brace (no nested braces here). */
function upstreamBody(conf: string, name: string): string {
  const match = new RegExp(`upstream\\s+${name}\\s*\\{([^}]*)\\}`).exec(conf);
  assert.ok(match !== null, `nginx.conf must define an 'upstream ${name}' block`);
  return match[1];
}

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

describe("nginx upstream re-resolution (infrastructure/docker/nginx)", () => {
  const UPSTREAMS = ["karyo-app", "keycloak"];

  for (const name of UPSTREAMS) {
    it(`re-resolves the '${name}' upstream at runtime instead of pinning a start-up address`, () => {
      const body = upstreamBody(readRepoFile(nginxConfPath), name);

      // The server address must carry the `resolve` parameter so nginx follows DNS changes...
      assert.match(
        body,
        new RegExp(`server\\s+${name}:8080\\s+resolve\\s*;`),
        `'upstream ${name}' must declare 'server ${name}:8080 resolve;'`,
      );
      // ...which requires a shared-memory `zone`; without it nginx rejects `resolve`.
      assert.match(body, /\bzone\s+\S+\s+\d+[kKmM]?\s*;/, `'upstream ${name}' must declare a 'zone'`);
      // The static form is the regression: it is what pinned the dead address and returned 502.
      assert.doesNotMatch(
        body,
        new RegExp(`server\\s+${name}:8080\\s*;`),
        `'upstream ${name}' must not pin a static 'server ${name}:8080;' (that is the 502 bug)`,
      );
    });
  }

  it("wires in the runtime-generated resolver", () => {
    const conf = readRepoFile(nginxConfPath);
    // `resolve` needs a `resolver`; it is generated per start-up and pulled in by this include.
    assert.match(
      conf,
      /include\s+\/etc\/nginx\/resolver\.conf\s*;/,
      "nginx.conf must include /etc/nginx/resolver.conf (written by docker-entrypoint.sh)",
    );
  });

  it("generates the resolver from the container's own /etc/resolv.conf", () => {
    const entrypoint = readRepoFile(entrypointPath);
    assert.match(entrypoint, /\/etc\/resolv\.conf/, "entrypoint must read the container's /etc/resolv.conf");
    assert.match(entrypoint, /\/etc\/nginx\/resolver\.conf/, "entrypoint must write /etc/nginx/resolver.conf");
    // ipv6=off keeps nginx from resolving upstreams to unreachable IPv6 records; valid= bounds
    // how long a stale address survives after a recreate.
    assert.match(entrypoint, /resolver\b.*\bipv6=off\b/, "the generated resolver must set ipv6=off");
    assert.match(entrypoint, /\bvalid=\d+[smh]?\b/, "the generated resolver must set a valid= lifetime");
    // Fail closed: no nameserver means no re-resolution, so start-up must abort rather than
    // silently ship a broken proxy.
    assert.match(entrypoint, /\[\s*-z\s+"\$resolvers"\s*\]/, "entrypoint must guard against an empty nameserver list");
  });

  it("extracts IPv4 nameservers from Docker and Podman resolv.conf (real awk program)", () => {
    const entrypoint = readRepoFile(entrypointPath);
    // Lift the exact awk program out of the entrypoint and run it, so this exercises the shipped
    // extraction logic rather than a copy of it.
    const awkMatch = /awk\s+'([^']*)'/.exec(entrypoint);
    assert.ok(awkMatch !== null, "entrypoint must extract nameservers with an awk program");
    const awkProgram = awkMatch[1];

    const cases: { label: string; resolvConf: string; expected: string[] }[] = [
      // Docker's embedded DNS.
      { label: "docker", resolvConf: "nameserver 127.0.0.11\noptions ndots:0\n", expected: ["127.0.0.11"] },
      // Podman/aardvark-dns answers on the network gateway, after search lines.
      {
        label: "podman",
        resolvConf: "search dns.podman example.local\nnameserver 10.89.13.1\n",
        expected: ["10.89.13.1"],
      },
      // Multiple nameservers, and an IPv6 entry that must be dropped (bare IPv6 would be invalid
      // nginx resolver syntax).
      {
        label: "multi+ipv6",
        resolvConf: "nameserver 127.0.0.11\nnameserver 8.8.8.8\nnameserver fe80::1\n",
        expected: ["127.0.0.11", "8.8.8.8"],
      },
      // No IPv4 nameserver at all: extraction yields nothing, which the entrypoint's -z guard
      // then turns into a hard failure.
      { label: "ipv6-only", resolvConf: "nameserver ::1\n", expected: [] },
    ];

    for (const testCase of cases) {
      const dir = makeTempDir();
      const resolvFile = join(dir, "resolv.conf");
      writeFileSync(resolvFile, testCase.resolvConf);
      const run = spawnSync("awk", [awkProgram, resolvFile], { encoding: "utf8" });
      assert.equal(run.status, 0, `awk failed for ${testCase.label}: ${run.stderr}`);
      const got = run.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
      assert.deepEqual(got, testCase.expected, `nameserver extraction for ${testCase.label}`);
    }
  });
});
