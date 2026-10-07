import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const rootPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const workspace = readFileSync(
  new URL("../pnpm-workspace.yaml", import.meta.url),
  "utf8",
);

function resolvedVersions(name) {
  const packagesStart = lockfile.indexOf("\npackages:\n");
  const snapshotsStart = lockfile.indexOf("\nsnapshots:\n");
  assert.ok(packagesStart > 0 && snapshotsStart > packagesStart, "lockfile has packages and snapshots sections");
  const section = lockfile.slice(packagesStart, snapshotsStart);
  const versions = [];
  for (const line of section.split("\n")) {
    const match = /^ {2}'?([^\s']+)'?:$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const at = key.lastIndexOf("@");
    if (at <= 0 || key.slice(0, at) !== name) continue;
    versions.push(key.slice(at + 1).replace(/\(.*$/, ""));
  }
  return versions;
}

function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

function assertAtLeast(name, floor) {
  const versions = resolvedVersions(name);
  assert.ok(versions.length > 0, `${name} resolves in pnpm-lock.yaml`);
  const below = versions.filter((version) => compareVersions(version, floor) < 0);
  assert.deepEqual(below, [], `${name} resolved below ${floor}: ${below.join(", ")}`);
}

test("proxy-addr resolves only to 2.0.8 or newer (CVE-2026-90711)", () => {
  assertAtLeast("proxy-addr", "2.0.8");
});

test("esbuild resolves only to 0.28.2 or newer (CVE-2024-24790, CVE-2025-68121)", () => {
  assertAtLeast("esbuild", "0.28.2");
});

test("pnpm overrides keep the Trivy dependency floors in both manifests", () => {
  const expected = {
    "proxy-addr": ">=2.0.8",
    "@esbuild-kit/core-utils>esbuild": "^0.28.2",
    "drizzle-kit>esbuild": "^0.28.2",
    "vite@6>esbuild": "^0.28.2",
  };
  const rootOverrides = rootPackage.pnpm?.overrides ?? {};
  for (const [selector, range] of Object.entries(expected)) {
    assert.equal(rootOverrides[selector], range, `package.json pnpm.overrides ${selector}`);
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      workspace,
      new RegExp(`^  "?${escaped}"?: "${range.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"$`, "m"),
      `pnpm-workspace.yaml overrides ${selector}`,
    );
  }
});
