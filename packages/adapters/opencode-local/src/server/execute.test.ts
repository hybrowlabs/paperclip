import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { ensureRemoteOpenCodeModelConfiguredAndAvailable, execute, prepareOpenCodeSkillIsolation } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);

async function createSkillDir(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
  return skillDir;
}

function probeResult(overrides: Record<string, unknown>) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

describe("OpenCode local skill injection", () => {
  let configHome: string;

  beforeEach(async () => {
    configHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-config-"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(configHome, { recursive: true, force: true });
  });

  it.each([false, true])("keeps chat policy with a legacy OpenCode prompt (custom=%s)", async (custom) => {
    const commandPath = path.join(configHome, "fake-opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValue(probeResult({ stdout: JSON.stringify({
      type: "text", sessionID: "chat-session", part: { text: "Reply" },
    }) }));
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    let prompt = "";
    const result = await execute({
      runId: "chat-run",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
        ...(custom ? { promptTemplate: "Custom agent instruction." } : {}),
      },
      context: {
        conversationMode: true,
        paperclipTaskMarkdown: directive,
        paperclipWake: {
          reason: "issue_commented", issue: { id: "chat-1", status: "in_progress", workMode: "planning" },
          interactionKind: "request_confirmation", interactionStatus: "accepted",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => { prompt = String(meta.prompt ?? ""); },
    });
    expect(result.exitCode).toBe(0);
    expect(prompt).toContain(directive);
    expect(prompt).toContain(custom ? "Custom agent instruction." : "Continue your Paperclip conversation");
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("Create child issues");
  });

  it("injects runtime skills into the configured child HOME", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-configured-home-"));
    const processHome = path.join(root, "process-home");
    const configuredHome = path.join(root, "configured-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const skillSource = await createSkillDir(path.join(root, "runtime-skills"), "paperclip");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({
        type: "text",
        sessionID: "session-configured-home",
        part: { text: "done" },
      }),
    }));

    try {
      const result = await execute({
        runId: "run-configured-home",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: {
            HOME: configuredHome,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          paperclipRuntimeSkills: [{
            key: "paperclipai/paperclip/paperclip",
            runtimeName: "paperclip",
            source: skillSource,
          }],
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const call = runProcessMock.mock.calls.at(-1)!;
      const invocationEnv = (call[4] as { env: Record<string, string> }).env;
      expect(invocationEnv.HOME).toBe(configuredHome);
      expect(invocationEnv.OPENCODE_CONFIG_DIR).toContain("paperclip-opencode-skills-");
      await expect(fs.lstat(path.join(configuredHome, ".claude", "skills", "paperclip"))).rejects.toThrow();
      await expect(fs.lstat(path.join(processHome, ".claude", "skills", "paperclip"))).rejects.toThrow();
      await expect(fs.access(invocationEnv.OPENCODE_CONFIG_DIR)).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("isolates four agents' selections across runs without altering personal skills", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-isolation-"));
    const names = Array.from({ length: 16 }, (_, index) => `skill-${index.toString().padStart(2, "0")}`);
    try {
      const entries = await Promise.all(names.map(async (name) => ({
        key: name,
        runtimeName: name,
        source: await createSkillDir(root, name),
      })));
      const personalHome = path.join(root, "home");
      const personal = await createSkillDir(path.join(personalHome, ".claude", "skills"), "personal");
      const selections = [
        ["Warden", names.slice(0, 14)],
        ["Sentinel", names.slice(0, 3)],
        ["Atlas", names.slice(0, 4)],
        ["Compass", names.slice(0, 2)],
      ] as const;
      for (const [agent, selected] of selections) {
        const isolated = await prepareOpenCodeSkillIsolation({}, entries, selected);
        try {
          const visible = await fs.readdir(isolated.skillsDir);
          expect(visible.sort(), agent).toEqual([...selected].sort());
          for (const name of names) {
            if (selected.includes(name)) expect(await fs.realpath(path.join(isolated.skillsDir, name))).toBe(await fs.realpath(path.join(root, name)));
            else await expect(fs.lstat(path.join(isolated.skillsDir, name))).rejects.toThrow();
          }
          const policy = JSON.parse(isolated.env.OPENCODE_CONFIG_CONTENT).permission.skill;
          expect(Object.keys(policy).sort()).toEqual(names.filter((name) => !selected.includes(name)).sort());
          expect(Object.values(policy)).toEqual(Array(names.length - selected.length).fill("deny"));
          expect(await fs.readFile(path.join(personal, "SKILL.md"), "utf8")).toContain("personal");
        } finally {
          await isolated.cleanup();
          await expect(fs.access(isolated.root)).rejects.toThrow();
        }
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retains a string default permission when adding skill denials", async () => {
    const isolated = await prepareOpenCodeSkillIsolation({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "allow" }) }, [
      { key: "excluded", runtimeName: "excluded", source: "/unused" },
    ], []);
    try {
      expect(JSON.parse(isolated.env.OPENCODE_CONFIG_CONTENT).permission).toEqual({ "*": "allow", skill: { excluded: "deny" } });
    } finally {
      await isolated.cleanup();
    }
  });

  it("denies excluded and missing skills despite stale shared-home links without changing that home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-shared-home-"));
    try {
      const homeSkills = path.join(root, "home", ".claude", "skills");
      await fs.mkdir(homeSkills, { recursive: true });
      const included = await createSkillDir(root, "included");
      const excluded = await createSkillDir(root, "excluded");
      const stale = path.join(homeSkills, "excluded");
      await fs.symlink(excluded, stale);
      const isolated = await prepareOpenCodeSkillIsolation({}, [
        { key: "included", runtimeName: "included", source: included },
        { key: "excluded", runtimeName: "excluded", source: excluded },
        { key: "missing", runtimeName: "missing", source: path.join(root, "missing"), sourceStatus: "missing" },
      ], ["included", "missing"]);
      try {
        expect(await fs.readdir(isolated.skillsDir)).toEqual(["included"]);
        expect(path.join(isolated.env.OPENCODE_CONFIG_DIR, "skills")).toBe(isolated.skillsDir);
        expect(JSON.parse(isolated.env.OPENCODE_CONFIG_CONTENT).permission.skill).toEqual({ excluded: "deny", missing: "deny" });
        expect(await fs.readlink(stale)).toBe(excluded);
      } finally {
        await isolated.cleanup();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retains inline settings while denying excluded skills, including when permissions are skipped", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-inline-"));
    try {
      const entries = await Promise.all(["included", "excluded"].map(async (name) => ({
        key: name, runtimeName: name, source: await createSkillDir(root, name),
      })));
      const isolated = await prepareOpenCodeSkillIsolation({
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { custom: {} }, permission: { skill: { excluded: "allow", personal: "allow" } } }),
      }, entries, ["included"]);
      try {
        const inline = JSON.parse(isolated.env.OPENCODE_CONFIG_CONTENT);
        expect(inline.provider).toEqual({ custom: {} });
        expect(inline.permission.skill).toEqual({ excluded: "deny", personal: "allow" });
        expect(await fs.readdir(isolated.skillsDir)).toEqual(["included"]);
      } finally {
        await isolated.cleanup();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes an OpenRouter key and complete model to OpenCode without logging the key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-openrouter-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const apiKey = "openrouter-test-secret";
    const model = "openrouter/anthropic/claude-sonnet-4.5";
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({
        type: "text",
        sessionID: "session-openrouter",
        part: { text: "done" },
      }),
    }));
    const logs: string[] = [];
    const metadata: unknown[] = [];

    try {
      const result = await execute({
        runId: "run-openrouter",
        agent: {
          id: "agent-openrouter",
          companyId: "company-1",
          name: "OpenRouter Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model,
          env: {
            OPENROUTER_API_KEY: apiKey,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          promptTemplate: "Run the task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
        onMeta: async (value) => {
          metadata.push(value);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.model).toBe(model);
      const executionCall = runProcessMock.mock.calls.at(-1)!;
      expect(executionCall[3]).toContain("--model");
      expect(executionCall[3]).toContain(model);
      expect((executionCall[4] as { env: Record<string, string> }).env.OPENROUTER_API_KEY).toBe(apiKey);
      expect(JSON.stringify({ logs, metadata, result })).not.toContain(apiKey);
      expect(JSON.stringify(metadata)).toContain('"OPENROUTER_API_KEY":"***REDACTED***"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable — probe is non-fatal when it cannot run", () => {
  const target = { kind: "remote", transport: "ssh" } as never;
  const base = {
    runId: "run-probe",
    executionTarget: target,
    command: "opencode",
    cwd: "/tmp",
    env: {} as Record<string, string>,
    timeoutSec: 30,
    graceSec: 5,
  };

  beforeEach(() => {
    runProcessMock.mockReset();
  });

  it("proceeds when the remote probe exits non-zero (e.g. a transient `Unexpected error`)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 1, stderr: "Unexpected error" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe times out", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ timedOut: true, exitCode: null }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe returns no models", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("still rejects when the probe succeeds but the configured model is absent (guard retained)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "openai/gpt-4.1\n" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).rejects.toThrow("Configured OpenCode model is unavailable on the remote execution target");
  });
});
