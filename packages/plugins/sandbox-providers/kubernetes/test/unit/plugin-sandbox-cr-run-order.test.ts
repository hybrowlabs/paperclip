import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  syncCalls: [] as Array<{ kind: "in" | "out"; remoteDir: string }>,
  execCalls: [] as string[][],
  released: [] as string[],
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => ({})),
}));
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: vi.fn(async () => undefined) }));
vi.mock("../../src/secret-manager.js", () => ({ createPerRunSecret: vi.fn(async () => undefined) }));
vi.mock("../../src/sandbox-cr-orchestrator.js", () => ({
  SandboxCrTimeoutError: class SandboxCrTimeoutError extends Error {},
  sandboxCrOrchestrator: {
    claim: vi.fn(async () => ({ uid: "uid-1" })),
    findPod: vi.fn(async (_c: unknown, _ns: string, name: string) => `${name}-pod`),
    waitForCompletion: vi.fn(async () => ({ phase: "Running", complete: true })),
    release: vi.fn(async (_c: unknown, _ns: string, name: string) => {
      h.released.push(name);
    }),
  },
}));
vi.mock("../../src/lease-lifecycle.js", () => ({
  checkLeaseResumable: vi.fn(async () => ({ resumable: true, phase: "Running", podName: "p" })),
  destroyLeaseResources: vi.fn(async () => undefined),
}));
vi.mock("../../src/pod-exec.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/pod-exec.js")>("../../src/pod-exec.js");
  return {
    ...actual,
    execInPod: vi.fn(async (_kc: unknown, _ns: string, _pod: string, _c: string, command: string[]) => {
      h.execCalls.push(command);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    }),
    execInPodStreaming: vi.fn(async () => ({ exitCode: 0, stderr: "" })),
  };
});
vi.mock("../../src/file-sync.js", () => ({
  performSyncIn: vi.fn(async (input: { remoteDir: string }) => {
    h.syncCalls.push({ kind: "in", remoteDir: input.remoteDir });
    return { operations: [] };
  }),
  performSyncOut: vi.fn(async (input: { remoteDir: string }) => {
    h.syncCalls.push({ kind: "out", remoteDir: input.remoteDir });
    return { operations: [] };
  }),
}));

import plugin from "../../src/plugin.js";

const CONFIG = { inCluster: true, backend: "sandbox-cr", adapterType: "opencode_local" };

beforeEach(() => {
  h.syncCalls.length = 0;
  h.execCalls.length = 0;
  h.released.length = 0;
});

async function acquire() {
  return await plugin.definition.onEnvironmentAcquireLease!({
    driverKey: "kubernetes",
    companyId: "acme",
    environmentId: "env-1",
    config: CONFIG,
    runId: "run-1",
  });
}

describe("sandbox-cr run order: acquire -> realize -> sync -> exec x N -> release", () => {
  it("a freshly acquired sandbox-cr lease already carries the pod workspace as its sync root", async () => {
    const lease = await acquire();
    expect(lease.metadata?.remoteCwd).toBe("/workspace");
  });

  it("native sync right after acquire (before realizeWorkspace) resolves a remote dir instead of failing", async () => {
    const lease = await acquire();
    const result = await plugin.definition.onEnvironmentSyncIn!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      lease,
      operations: [],
    });
    expect(result).toBeDefined();
    expect(h.syncCalls).toEqual([{ kind: "in", remoteDir: "/workspace" }]);
  });

  it("runs the full order and keeps the realized cwd as the sync root", async () => {
    const lease = await acquire();
    expect(lease.providerLeaseId).toBeTruthy();

    const realized = await plugin.definition.onEnvironmentRealizeWorkspace!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      lease,
      workspace: { localPath: "/host/ws", remotePath: "/workspace/project" },
    });
    expect(realized.cwd).toBe("/workspace/project");

    // The server persists the realized cwd on the lease (environment-run-orchestrator).
    const syncedLease = {
      ...lease,
      metadata: { ...(lease.metadata ?? {}), remoteCwd: realized.cwd },
    };
    const base = {
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      lease: syncedLease,
      operations: [],
    };
    await plugin.definition.onEnvironmentSyncIn!(base);

    for (const args of [["-c", "git rev-parse --show-toplevel"], ["-c", "git status --porcelain"], ["-c", "opencode --version"]]) {
      const res = await plugin.definition.onEnvironmentExecute!({
        driverKey: "kubernetes",
        companyId: "acme",
        environmentId: "env-1",
        config: CONFIG,
        lease: syncedLease,
        command: "sh",
        args,
        cwd: "/workspace/project",
        env: {},
      });
      expect(res.exitCode).toBe(0);
    }
    expect(h.execCalls).toHaveLength(3);

    await plugin.definition.onEnvironmentSyncOut!(base);
    expect(h.syncCalls).toEqual([
      { kind: "in", remoteDir: "/workspace/project" },
      { kind: "out", remoteDir: "/workspace/project" },
    ]);

    await plugin.definition.onEnvironmentReleaseLease!({
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: lease.providerLeaseId!,
      leaseMetadata: syncedLease.metadata,
    });
    expect(h.released).toEqual([lease.providerLeaseId]);
  });

  it("a resumed sandbox-cr lease without a recorded root falls back to /workspace and keeps a recorded custom root", async () => {
    const base = {
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "env-1",
      config: CONFIG,
      providerLeaseId: "pc-abc",
    };
    const meta = { namespace: "paperclip-acme", jobName: "pc-abc", podName: "p", secretName: "pc-abc-env", backend: "sandbox-cr" };
    const bare = await plugin.definition.onEnvironmentResumeLease!({ ...base, leaseMetadata: meta });
    expect(bare.metadata?.remoteCwd).toBe("/workspace");
    const custom = await plugin.definition.onEnvironmentResumeLease!({
      ...base,
      leaseMetadata: { ...meta, remoteCwd: "/workspace/project" },
    });
    expect(custom.metadata?.remoteCwd).toBe("/workspace/project");
  });
});
