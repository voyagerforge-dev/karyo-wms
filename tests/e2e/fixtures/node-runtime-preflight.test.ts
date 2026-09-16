import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";

/**
 * Behavioral coverage for scripts/lib/node-runtime.sh, the preflight shared by
 * scripts/deploy-server.sh and scripts/run-e2e.sh.
 *
 * Each case spawns a real `bash -c 'source scripts/lib/node-runtime.sh && karyo_require_node'`
 * with a PATH that contains only symlinked tools (bash sh head tr dirname) plus a fake `node`
 * binary, so the assertions exercise the library's real process handling - shell parsing,
 * PATH lookup and `node --version` capture - not its source text.
 *
 * The declared line is read from .nvmrc (the one declaration; nvm and CI's setup-node consume
 * it too), and the mirrors that cannot read a file - manifests, lockfile roots, .npmrc
 * enforcement and the nginx builder stages - are asserted equal to it.
 */
const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function resolveFromPath(tool: string): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, tool);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`tool not found on PATH: ${tool}`);
}

/** Temporary directories created by the helpers, removed after every test. */
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "karyo-"));
  tempDirs.push(dir);
  return dir;
}

function declaredMajor(): string {
  return readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim();
}

type PreflightOptions = {
  /** What the fake `node` binary prints to stdout, or null to omit `node` from the PATH. */
  version?: string | null;
  /** Overrides the declaration file the library reads (KARYO_NVMRC). */
  nvmrc?: string;
};

/** Runs the real preflight in a trimmed environment and returns its output and exit status. */
function runPreflight({ version = "v24.21.0", nvmrc }: PreflightOptions = {}): {
  output: string;
  status: number;
} {
  const tmp = makeTempDir();
  const toolsDir = join(tmp, "tools");
  const nodeDir = join(tmp, "node");
  mkdirSync(toolsDir);

  // The spawned process must be able to run even though the child PATH carries only these.
  for (const tool of ["bash", "sh", "head", "tr", "dirname"]) {
    symlinkSync(resolveFromPath(tool), join(toolsDir, tool));
  }

  let path = toolsDir;
  if (version !== null) {
    mkdirSync(nodeDir);
    const fakeNode = join(nodeDir, "node");
    writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
    chmodSync(fakeNode, 0o755);
    path = `${nodeDir}:${toolsDir}`;
  }

  const spawned = spawnSync("bash", [
    "-c",
    "source scripts/lib/node-runtime.sh && karyo_require_node",
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: path,
      ...(nvmrc !== undefined ? { KARYO_NVMRC: nvmrc } : {}),
    },
  });

  const stdout = spawned.stdout?.toString() ?? "";
  const stderr = spawned.stderr?.toString() ?? "";
  return { output: `${stdout}${stderr}`.trim(), status: spawned.status ?? -1 };
}

/** Writes a KARYO_NVMRC file with the given content and returns its path. */
function writeDeclaration(content: string): string {
  const tmp = makeTempDir();
  const file = join(tmp, "nvmrc");
  writeFileSync(file, content);
  return file;
}

describe("node-runtime preflight (scripts/lib/node-runtime.sh)", () => {
  const SUPPORTED = ["v24.0.0", "v24.21.0"];
  const OLDER_MAJORS = ["v20.19.0", "v22.13.0", "v22.22.2", "v23.11.1"];
  const FUTURE_MAJORS = ["v25.0.0", "v26.8.2"];
  const UNREADABLE = ["", "garbage", "24"];

  for (const version of SUPPORTED) {
    it(`accepts ${version}`, () => {
      const { output, status } = runPreflight({ version });
      assert.equal(status, 0, `preflight should pass: ${output}`);
      assert.equal(output, "");
    });
  }

  it("rejects majors older than the declared line", () => {
    for (const version of OLDER_MAJORS) {
      const { output, status } = runPreflight({ version });
      assert.notEqual(status, 0, `${version} must be rejected`);
      assert.match(
        output,
        new RegExp(`Node ${version.replace(/\./g, "\\.")} is not supported`),
        `${version} rejection must name the version`,
      );
      assert.match(output, new RegExp(`Node ${declaredMajor()}\\.x`), `${version} rejection must state the supported line`);
      assert.match(output, /\.nvmrc/, `${version} rejection must point at .nvmrc`);
    }
  });

  it("rejects future majors 25 and 26 instead of claiming them", () => {
    for (const version of FUTURE_MAJORS) {
      const { output, status } = runPreflight({ version });
      assert.notEqual(status, 0, `${version} must be rejected`);
      assert.match(
        output,
        new RegExp(`Node ${version.replace(/\./g, "\\.")} is not supported`),
        `${version} rejection must name the version`,
      );
      assert.match(output, new RegExp(`Node ${declaredMajor()}\\.x`), `${version} rejection must state the supported line`);
      assert.match(output, /\.nvmrc/, `${version} rejection must point at .nvmrc`);
    }
  });

  for (const version of UNREADABLE) {
    it(`rejects an unreadable node --version (${version === "" ? "empty" : JSON.stringify(version)})`, () => {
      const { output, status } = runPreflight({ version });
      assert.notEqual(status, 0, "an unreadable version must be rejected");
      assert.match(output, /Node version unreadable/);
    });
  }

  it("rejects a node missing from the PATH", () => {
    const { output, status } = runPreflight({ version: null });
    assert.notEqual(status, 0, "a missing node must be rejected");
    assert.match(output, /Node\.js not found/);
  });

  it("fails closed when KARYO_NVMRC points at a missing file", () => {
    const { output, status } = runPreflight({ nvmrc: join(makeTempDir(), "missing") });
    assert.notEqual(status, 0, "a missing declaration must be a hard failure");
    assert.match(output, /Node version declaration not found/);
  });

  it("fails closed when KARYO_NVMRC is not a bare integer (lts/*)", () => {
    const { output, status } = runPreflight({ nvmrc: writeDeclaration("lts/*\n") });
    assert.notEqual(status, 0, "a non-integer declaration must be a hard failure");
    assert.match(output, /not a bare integer/);
  });

  it("keeps .nvmrc itself a bare integer", () => {
    const declared = declaredMajor();
    assert.match(declared, /^[0-9]+$/, `.nvmrc must be a bare integer, got '${declared}'`);
  });

  it("mirrors ^<declared>.0.0 in every manifest and lockfile root, with engine-strict on", () => {
    const declared = declaredMajor();
    const expected = `^${declared}.0.0`;
    for (const dir of ["frontend/web", "frontend/mobile", "tests/e2e"]) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8"));
      assert.equal(manifest.engines.node, expected, `${dir}/package.json engines.node`);
      const lockfile = JSON.parse(readFileSync(join(repoRoot, dir, "package-lock.json"), "utf8"));
      assert.equal(lockfile.packages[""].engines.node, expected, `${dir}/package-lock.json root engines.node`);
      assert.match(readFileSync(join(repoRoot, dir, ".npmrc"), "utf8"), /engine-strict=true/, `${dir}/.npmrc`);
    }
  });

  it("runs both nginx builder stages on the declared major", () => {
    const declared = declaredMajor();
    const dockerfile = readFileSync(join(repoRoot, "infrastructure/docker/Dockerfile.nginx"), "utf8");
    const majors = [...dockerfile.matchAll(/node:(\d+)-alpine/g)].map((match) => match[1]);
    assert.equal(majors.length, 2, "both builder stages must declare node:<major>-alpine");
    for (const major of majors) {
      assert.equal(major, declared, `builder stage major must equal .nvmrc`);
    }
  });
});