import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inferOpenAiCompatibleBiller, type AdapterExecutionContext, type AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  overrideAdapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  adapterExecutionTargetUsesPaperclipBridge,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  readAdapterExecutionTarget,
  readAdapterExecutionTargetHomeDir,
  resolveAdapterExecutionTargetTimeoutSec,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  joinPromptSections,
  buildInvocationEnvForLogs,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
  isPaperclipRecoveryWakePayload,
  stringifyPaperclipWakePayload,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  runChildProcess,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipIssueWorkModeFromContext,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl } from "./parse.js";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  isTruthyEnvFlag,
  parseOpenCodeModelsOutput,
  requireOpenCodeModelId,
} from "./models.js";
import { prepareOpenCodeRuntimeConfig, prepareManagedOpenCodeRemoteHomes } from "./runtime-config.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function resolveOpenCodeBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

const REMOTE_OPENCODE_MODELS_PROBE_DEFAULT_TIMEOUT_SEC = 20;
const REMOTE_OPENCODE_MODELS_PROBE_SANDBOX_TIMEOUT_SEC = 120;

export async function ensureRemoteOpenCodeModelConfiguredAndAvailable(input: {
  runId: string;
  executionTarget: NonNullable<AdapterExecutionContext["executionTarget"]>;
  command: string;
  model: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
}) {
  const model = requireOpenCodeModelId(input.model);

  // When the caller opts into OPENCODE_ALLOW_ALL_MODELS, OpenCode accepts any
  // provider/model at run time (e.g. gateway-routed models that never appear in
  // `opencode models` output). Honour that on the REMOTE path too by skipping the
  // remote availability probe; we still enforce the provider/model format above.
  // Mirrors the local ensureOpenCodeModelConfiguredAndAvailable bypass. Prefer the
  // explicit run env, then the process env.
  if (isTruthyEnvFlag(input.env.OPENCODE_ALLOW_ALL_MODELS ?? process.env.OPENCODE_ALLOW_ALL_MODELS)) {
    return;
  }

  const defaultProbeTimeoutSec =
    input.executionTarget.kind === "remote" && input.executionTarget.transport === "sandbox"
      ? REMOTE_OPENCODE_MODELS_PROBE_SANDBOX_TIMEOUT_SEC
      : REMOTE_OPENCODE_MODELS_PROBE_DEFAULT_TIMEOUT_SEC;
  const probeTimeoutSec = input.timeoutSec > 0
    ? Math.min(input.timeoutSec, defaultProbeTimeoutSec)
    : defaultProbeTimeoutSec;
  const probe = await runAdapterExecutionTargetProcess(
    input.runId,
    input.executionTarget,
    input.command,
    ["models"],
    {
      cwd: input.cwd,
      env: input.env,
      timeoutSec: probeTimeoutSec,
      graceSec: input.graceSec,
      onLog: async () => {},
    },
  );

  // The remote availability probe is a best-effort pre-flight guard, not a gate.
  // If `opencode models` itself cannot run on the target — timeout, transient CLI
  // error, provider hiccup — do NOT abort the run. The real invocation is
  // authoritative, so a probe that can't execute must never be fatal. (Previously
  // these threw and crashed runs mid-flight, losing the agent's work + disposition.)
  if (probe.timedOut) {
    console.warn(
      `[opencode-local] Remote model availability probe for "${model}" timed out after ${probeTimeoutSec}s; proceeding with the configured model.`,
    );
    return;
  }

  if ((probe.exitCode ?? 1) !== 0) {
    const detail = firstNonEmptyLine(probe.stderr) || firstNonEmptyLine(probe.stdout);
    console.warn(
      `[opencode-local] Remote \`opencode models\` could not run for "${model}"${
        detail ? ` (${detail})` : ""
      }; proceeding with the configured model.`,
    );
    return;
  }

  const models = parseOpenCodeModelsOutput(probe.stdout);
  if (models.length === 0) {
    console.warn(
      `[opencode-local] Remote \`opencode models\` returned no models; proceeding with the configured model "${model}".`,
    );
    return;
  }

  if (!models.some((entry) => entry.id === model)) {
    const sample = models.slice(0, 12).map((entry) => entry.id).join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable on the remote execution target: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }
}

function buildOpenCodeSkillConfigContent(env: Record<string, string>, denied: Set<string>): string {
  const existingContent = env.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
  const parsed = existingContent ? JSON.parse(existingContent) as unknown : {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object for skill isolation.");
  }
  const content = parsed as Record<string, unknown>;
  const permission = typeof content.permission === "object" && content.permission !== null && !Array.isArray(content.permission)
    ? content.permission as Record<string, unknown>
    : typeof content.permission === "string" ? { "*": content.permission } : {};
  const skill = typeof permission.skill === "object" && permission.skill !== null && !Array.isArray(permission.skill)
    ? permission.skill as Record<string, unknown> : {};
  return JSON.stringify({
    ...content,
    permission: { ...permission, skill: { ...skill, ...Object.fromEntries([...denied].sort().map((name) => [name, "deny"])) } },
  });
}

function selectOpenCodeSkills(
  entries: Array<{ key: string; runtimeName: string; source: string; sourceStatus?: "available" | "missing" }>,
  desired: string[],
) {
  const selected = new Set(desired);
  const denied = new Set<string>();
  const included: typeof entries = [];
  for (const entry of entries) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.runtimeName)) {
      throw new Error(`Invalid OpenCode skill name: ${entry.runtimeName}`);
    }
    if (!selected.has(entry.key) || isPaperclipSkillSourceMissing(entry)) {
      denied.add(entry.runtimeName);
    } else {
      included.push(entry);
    }
  }
  return { denied, included };
}

export async function prepareOpenCodeSkillIsolation(
  env: Record<string, string>,
  entries: Array<{ key: string; runtimeName: string; source: string; sourceStatus?: "available" | "missing" }>,
  desired: string[],
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-skills-"));
  const configDir = path.join(root, "config");
  const skillsDir = path.join(configDir, "skills");
  try {
    await fs.mkdir(skillsDir, { recursive: true });
    const { denied, included } = selectOpenCodeSkills(entries, desired);
    for (const entry of included) {
      await fs.symlink(entry.source, path.join(skillsDir, entry.runtimeName));
    }
    return {
      root,
      configDir,
      skillsDir,
      env: {
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_CONFIG_CONTENT: buildOpenCodeSkillConfigContent(env, denied),
      },
      cleanup: () => fs.rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "opencode");
  const model = asString(config.model, "").trim();
  const variant = asString(config.variant, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  const openCodeSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredOpenCodeSkillNames = resolveLegacyPaperclipDesiredSkillNames(config, openCodeSkillEntries);

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
  };
  env.PAPERCLIP_RUN_ID = runId;
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceHints,
    agentHome,
    executionTargetIsRemote,
    executionCwd: effectiveExecutionCwd,
  });
  // Prevent OpenCode from writing an opencode.json config file into the
  // project working directory (which would pollute the git repo).  Model
  // selection is already handled via the --model CLI flag.  Set after the
  // envConfig loop so user overrides cannot disable this guard.
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  const preparedRuntimeConfig = await prepareOpenCodeRuntimeConfig({ env, config });
  let isolatedSkills: Awaited<ReturnType<typeof prepareOpenCodeSkillIsolation>> | null = null;
  try {
    if (!executionTargetIsRemote) {
      isolatedSkills = await prepareOpenCodeSkillIsolation(
        preparedRuntimeConfig.env,
        openCodeSkillEntries,
        desiredOpenCodeSkillNames,
      );
      Object.assign(preparedRuntimeConfig.env, isolatedSkills.env);
    }
  } catch (error) {
    await preparedRuntimeConfig.cleanup();
    throw error;
  }
  const localRuntimeConfigHome =
    preparedRuntimeConfig.notes.length > 0 ? preparedRuntimeConfig.env.XDG_CONFIG_HOME : "";
  try {
    const runtimeEnv = Object.fromEntries(
      Object.entries(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env })).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      runId,
      target: executionTarget,
      installCommand: ctx.runtimeCommandSpec?.installCommand,
    detectCommand: ctx.runtimeCommandSpec?.detectCommand,
      cwd,
      env: runtimeEnv,
      timeoutSec,
      graceSec,
      onLog,
    });
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    let loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    if (!executionTargetIsRemote) {
      await ensureOpenCodeModelConfiguredAndAvailable({
        model,
        command,
        cwd,
        env: runtimeEnv,
      });
    }

    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();
    let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
    let remoteRuntimeRootDir: string | null = null;
    let paperclipBridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>> = null;

    if (executionTarget?.kind === "remote") {
      isolatedSkills = await prepareOpenCodeSkillIsolation(
        preparedRuntimeConfig.env,
        openCodeSkillEntries,
        desiredOpenCodeSkillNames,
      );
      await onLog(
        "stdout",
        `[paperclip] Syncing workspace and OpenCode runtime assets to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "opencode",
        timeoutSec,
        workspaceLocalDir: cwd,
        installCommand: SANDBOX_INSTALL_COMMAND,
        detectCommand: command,
        onProgress: (line) => onLog("stdout", line),
        onRuntimeProgress: ctx.onRuntimeProgress,
        assets: [
          {
            key: "skills",
            localDir: isolatedSkills.skillsDir,
            followSymlinks: true,
          },
          ...(localRuntimeConfigHome
            ? [{
              key: "xdgConfig",
              localDir: localRuntimeConfigHome,
            }]
            : []),
        ],
      });
      restoreRemoteWorkspace = () =>
        preparedExecutionTargetRuntime.restoreWorkspace((line) => onLog("stdout", line));
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
      refreshPaperclipWorkspaceEnvForExecution({
        env: preparedRuntimeConfig.env,
        envConfig,
        workspaceCwd: effectiveWorkspaceCwd,
        workspaceSource,
        workspaceId,
        workspaceRepoUrl,
        workspaceRepoRef,
        workspaceHints,
        agentHome,
        executionTargetIsRemote,
        executionCwd: effectiveExecutionCwd,
      });
      remoteRuntimeRootDir = preparedExecutionTargetRuntime.runtimeRootDir;
      const managedHome = adapterExecutionTargetUsesManagedHome(executionTarget);
      if (managedHome && preparedExecutionTargetRuntime.runtimeRootDir) {
        preparedRuntimeConfig.env.HOME = preparedExecutionTargetRuntime.runtimeRootDir;
      }
      if (localRuntimeConfigHome && preparedExecutionTargetRuntime.assetDirs.xdgConfig) {
        preparedRuntimeConfig.env.XDG_CONFIG_HOME = preparedExecutionTargetRuntime.assetDirs.xdgConfig;
      }
      prepareManagedOpenCodeRemoteHomes({
        env: preparedRuntimeConfig.env,
        config,
        runtimeRootDir: preparedExecutionTargetRuntime.runtimeRootDir,
        runId,
        configDir: preparedExecutionTargetRuntime.assetDirs.xdgConfig,
      });
      const remoteHomeDir = config.managedAiConnection
        ? preparedRuntimeConfig.env.HOME
        : managedHome && preparedExecutionTargetRuntime.runtimeRootDir
          ? preparedExecutionTargetRuntime.runtimeRootDir
          : await readAdapterExecutionTargetHomeDir(runId, executionTarget, {
            cwd,
            env: preparedRuntimeConfig.env,
            timeoutSec,
            graceSec,
            onLog,
          });
      if (preparedExecutionTargetRuntime.assetDirs.skills) {
        preparedRuntimeConfig.env.OPENCODE_CONFIG_DIR = path.posix.dirname(preparedExecutionTargetRuntime.assetDirs.skills);
        preparedRuntimeConfig.env.OPENCODE_CONFIG_CONTENT = isolatedSkills.env.OPENCODE_CONFIG_CONTENT;
      }
      if (remoteHomeDir) {
        preparedRuntimeConfig.env.HOME ??= remoteHomeDir;
      }
      await ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId,
        executionTarget,
        command,
        model,
        cwd,
        env: preparedRuntimeConfig.env,
        timeoutSec,
        graceSec,
      });
    }
    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    if (executionTargetIsRemote && adapterExecutionTargetUsesPaperclipBridge(runtimeExecutionTarget)) {
      paperclipBridge = await startAdapterExecutionTargetPaperclipBridge({
        runId,
        target: runtimeExecutionTarget,
        enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(runtimeExecutionTarget),
        duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(runtimeExecutionTarget),
        runtimeRootDir: remoteRuntimeRootDir,
        adapterKey: "opencode",
        timeoutSec,
        hostApiToken: preparedRuntimeConfig.env.PAPERCLIP_API_KEY,
        onLog,
      });
      if (paperclipBridge) {
        Object.assign(preparedRuntimeConfig.env, paperclipBridge.env);
        loggedEnv = buildInvocationEnvForLogs(preparedRuntimeConfig.env, {
          runtimeEnv: Object.fromEntries(
            Object.entries(ensurePathInEnv({ ...process.env, ...preparedRuntimeConfig.env })).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          includeRuntimeKeys: ["HOME"],
          resolvedCommand,
        });
      }
    }

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
      adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionId = canResumeSession ? runtimeSessionId : null;
    if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] OpenCode session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
      );
    } else if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[paperclip] OpenCode session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
      );
    }
    const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
    const resolvedInstructionsFilePath = instructionsFilePath
      ? path.resolve(cwd, instructionsFilePath)
      : "";
    const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
    let instructionsPrefix = "";
    if (resolvedInstructionsFilePath) {
      try {
        const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
        instructionsPrefix =
          `${instructionsContents}\n\n` +
          `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
          `Resolve any relative file references from ${instructionsDir}.\n\n`;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await onLog(
          "stdout",
          `[paperclip] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
        );
      }
    }

    const commandNotes = (() => {
      const notes = [...preparedRuntimeConfig.notes];
      if (!resolvedInstructionsFilePath) return notes;
      if (instructionsPrefix.length > 0) {
        notes.push(`Loaded agent instructions from ${resolvedInstructionsFilePath}`);
        notes.push(
          `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
        );
        return notes;
      }
      notes.push(
        `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
      );
      return notes;
    })();

    const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const renderedBootstrapPrompt =
      !sessionId && bootstrapPromptTemplate.trim().length > 0
        ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
        : "";
    const taskContextNote = context.conversationMode === true
      ? selectPaperclipTaskMarkdown(context, { resumedSession: Boolean(sessionId) })
      : "";
    const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
      conversationMode: context.conversationMode === true,
      resumedSession: Boolean(sessionId),
      suppressIssueDescription: taskContextNote.length > 0,
    });
    const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
    const renderedPrompt = shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const prompt = joinPromptSections([
      instructionsPrefix,
      renderedBootstrapPrompt,
      wakePrompt,
      taskContextNote,
      sessionHandoffNote,
      renderedPrompt,
    ]);
    const promptMetrics = {
      promptChars: prompt.length,
      instructionsChars: instructionsPrefix.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      taskContextChars: taskContextNote.length,
      sessionHandoffChars: sessionHandoffNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    };

    // Optional diagnostic: surface OpenCode's own logs on stderr (captured into the
    // run result) so failures that OpenCode otherwise wraps as an opaque
    // "Unexpected server error" can be diagnosed in remote/sandbox runs where the
    // log file is unreachable. Toggle via PAPERCLIP_OPENCODE_PRINT_LOGS (run env,
    // then process env).
    const printLogs = isTruthyEnvFlag(
      env.PAPERCLIP_OPENCODE_PRINT_LOGS ?? process.env.PAPERCLIP_OPENCODE_PRINT_LOGS,
    );
    const buildArgs = (resumeSessionId: string | null) => {
      const args = ["run", "--format", "json"];
      if (printLogs) args.push("--print-logs");
      if (resumeSessionId) args.push("--session", resumeSessionId);
      if (model) args.push("--model", model);
      if (variant) args.push("--variant", variant);
      if (extraArgs.length > 0) args.push(...extraArgs);
      return args;
    };

    const runAttempt = async (resumeSessionId: string | null) => {
      const args = buildArgs(resumeSessionId);
      if (onMeta) {
        await onMeta({
          adapterType: "opencode_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: [...args, `<stdin prompt ${prompt.length} chars>`],
          env: loggedEnv,
          prompt,
          promptMetrics,
          context,
        });
      }

      const proc = await runAdapterExecutionTargetProcess(runId, runtimeExecutionTarget, command, args, {
        cwd,
        env: preparedRuntimeConfig.env,
        stdin: prompt,
        timeoutSec,
        graceSec,
        onSpawn,
        onRuntimeProgress: ctx.onRuntimeProgress,
        onLog,
        runLogTail: paperclipBridge?.runLogTail,
        settleRunDisposition: paperclipBridge?.settleRunDisposition,
      });
      return {
        proc,
        rawStderr: proc.stderr,
        parsed: parseOpenCodeJsonl(proc.stdout),
      };
    };

    const toResult = (
      attempt: {
        proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string; errorCode?: string | null };
        rawStderr: string;
        parsed: ReturnType<typeof parseOpenCodeJsonl>;
      },
      clearSessionOnMissingSession = false,
    ): AdapterExecutionResult => {
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const resolvedSessionId =
        attempt.parsed.sessionId ??
        (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
      const resolvedSessionParams = resolvedSessionId
        ? ({
            sessionId: resolvedSessionId,
            cwd: effectiveExecutionCwd,
            ...(workspaceId ? { workspaceId } : {}),
            ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
            ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
            ...(executionTargetIsRemote
              ? {
                  remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
                }
              : {}),
          } as Record<string, unknown>)
        : null;

      const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const rawExitCode = attempt.proc.exitCode;
      const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
      const fallbackErrorMessage =
        parsedError ||
        stderrLine ||
        `OpenCode exited with code ${synthesizedExitCode ?? -1}`;
      const modelId = model || null;

      return {
        exitCode: synthesizedExitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
        // Forward the transport-level error code from the run-disposition seam.
        // A lost duplex control channel surfaces the typed `duplex_channel_lost`
        // code; every other result carries no code here.
        errorCode: attempt.proc.errorCode ?? null,
        usage: {
          inputTokens: attempt.parsed.usage.inputTokens,
          outputTokens: attempt.parsed.usage.outputTokens,
          cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: parseModelProvider(modelId),
        biller: resolveOpenCodeBiller(runtimeEnv, parseModelProvider(modelId)),
        model: modelId,
        billingType: "unknown",
        costUsd: attempt.parsed.costUsd,
        resultJson: {
          stdout: attempt.proc.stdout,
          stderr: attempt.proc.stderr,
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
      };
    };

    try {
      const initial = await runAttempt(sessionId);
      const initialFailed =
        !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage));
      if (
        sessionId &&
        initialFailed &&
        isOpenCodeUnknownSessionError(initial.proc.stdout, initial.rawStderr)
      ) {
        await onLog(
          "stdout",
          `[paperclip] OpenCode session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
        );
        const retry = await runAttempt(null);
        return toResult(retry, true);
      }

      return toResult(initial);
    } finally {
      await Promise.all([
        paperclipBridge?.stop(),
        restoreRemoteWorkspace?.(),
      ]);
    }
  } finally {
    await Promise.all([preparedRuntimeConfig.cleanup(), isolatedSkills?.cleanup()]);
  }
}
