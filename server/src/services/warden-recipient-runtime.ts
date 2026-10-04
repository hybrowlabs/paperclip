import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WardenCheckRunner } from "../routes/warden-recipient-checks.js";
import type { WardenServerPorts } from "./warden-recipient-check.js";

export interface WardenRunnerConfig {
  expectedRecipientAgentId: string;
  driver: "kubernetes";
  backend: "job";
  egressMode: "cilium";
  namespace: string;
  image: string;
  imageAllowPrefixes: readonly string[];
  deadlineSeconds?: number;
  runtimeClassName?: string;
}

export interface WardenRunnerModule {
  runWardenRecipientCheck(deps: Record<string, unknown>, actor: unknown, rawRequest: unknown, signal?: AbortSignal): Promise<unknown>;
  startRecipientLeaseSweeper(
    clients: unknown,
    input: { namespace: string; intervalMs?: number; maxAgeSeconds?: number; onError?: (code: "sweep_failed") => void },
  ): { stop(): void };
}

export interface WardenKubeModule {
  createKubeConfig(input: { inCluster?: boolean; kubeconfig?: string }): unknown;
  makeKubeClients(kc: unknown): unknown;
}

export interface WardenRecipientRuntime {
  wardenRecipientAgentId: string;
  createRunner: (ports: WardenServerPorts) => WardenCheckRunner;
  stop(): void;
}

export interface WardenRuntimeLoader {
  loadRunner(distDir: string): Promise<WardenRunnerModule>;
  loadKube(distDir: string): Promise<WardenKubeModule>;
}

const defaultLoader: WardenRuntimeLoader = {
  loadRunner: async (distDir) =>
    (await import(pathToFileURL(path.join(distDir, "warden-recipient", "index.js")).href)) as WardenRunnerModule,
  loadKube: async (distDir) => (await import(pathToFileURL(path.join(distDir, "kube-client.js")).href)) as WardenKubeModule,
};

export interface WardenRuntimeLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export function readWardenRecipientAgentId(env: Record<string, string | undefined>): string | null {
  return env.PAPERCLIP_WARDEN_RECIPIENT_AGENT_ID?.trim() || null;
}

export function readWardenRunnerConfig(env: Record<string, string | undefined>): { config: WardenRunnerConfig; distDir: string } | null {
  const expectedRecipientAgentId = readWardenRecipientAgentId(env);
  const namespace = env.PAPERCLIP_WARDEN_RECIPIENT_NAMESPACE?.trim();
  const image = env.PAPERCLIP_WARDEN_RECIPIENT_IMAGE?.trim();
  const prefixes = (env.PAPERCLIP_WARDEN_RECIPIENT_IMAGE_ALLOW_PREFIXES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const distDir = env.PAPERCLIP_WARDEN_RECIPIENT_PLUGIN_DIST?.trim();
  if (!expectedRecipientAgentId || !namespace || !image || prefixes.length === 0 || !distDir) return null;
  const deadline = Number(env.PAPERCLIP_WARDEN_RECIPIENT_DEADLINE_SECONDS);
  return {
    distDir,
    config: {
      expectedRecipientAgentId,
      driver: "kubernetes",
      backend: "job",
      egressMode: "cilium",
      namespace,
      image,
      imageAllowPrefixes: prefixes,
      ...(Number.isFinite(deadline) && deadline > 0 ? { deadlineSeconds: deadline } : {}),
      ...(env.PAPERCLIP_WARDEN_RECIPIENT_RUNTIME_CLASS?.trim() ? { runtimeClassName: env.PAPERCLIP_WARDEN_RECIPIENT_RUNTIME_CLASS.trim() } : {}),
    },
  };
}

export async function createWardenRecipientRuntime(input: {
  env: Record<string, string | undefined>;
  logger?: WardenRuntimeLogger;
  loader?: WardenRuntimeLoader;
}): Promise<WardenRecipientRuntime | null> {
  const resolved = readWardenRunnerConfig(input.env);
  if (!resolved) return null;
  const loader = input.loader ?? defaultLoader;
  try {
    const [runner, kube] = await Promise.all([loader.loadRunner(resolved.distDir), loader.loadKube(resolved.distDir)]);
    const kubeconfig = input.env.PAPERCLIP_WARDEN_RECIPIENT_KUBECONFIG;
    const clients = kube.makeKubeClients(
      kube.createKubeConfig(kubeconfig?.trim() ? { kubeconfig } : { inCluster: true }),
    );
    const sweeper = runner.startRecipientLeaseSweeper(clients, {
      namespace: resolved.config.namespace,
      onError: () => input.logger?.warn({ code: "sweep_failed" }, "warden recipient lease sweep failed"),
    });
    return {
      wardenRecipientAgentId: resolved.config.expectedRecipientAgentId,
      createRunner: (ports) => (actor, rawRequest, signal) =>
        runner.runWardenRecipientCheck(
          {
            clients,
            preflight: ports.preflight,
            grants: ports.grants,
            delivery: ports.delivery,
            aliases: ports.aliases,
            audit: ports.audit,
            config: resolved.config,
          },
          actor,
          rawRequest,
          signal,
        ),
      stop: () => sweeper.stop(),
    };
  } catch {
    input.logger?.warn({ code: "runtime_unavailable" }, "warden recipient runtime could not be initialised; route stays disabled");
    return null;
  }
}
