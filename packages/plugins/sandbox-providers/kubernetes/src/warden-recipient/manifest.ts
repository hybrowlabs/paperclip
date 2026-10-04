import { WARDEN_RECIPE } from "./recipe.js";
import { WARDEN_RECIPIENT_ROLE } from "./egress.js";

const DIGEST_IMAGE = /^[a-z0-9][a-z0-9._\-/:]{0,200}@sha256:[0-9a-f]{64}$/;

export class ManifestError extends Error {
  constructor(readonly code: "image_not_digest_pinned" | "image_not_allowed" | "deadline_out_of_range") {
    super(code);
    this.name = "ManifestError";
  }
}

export interface RecipientJobInput {
  namespace: string;
  checkId: string;
  image: string;
  imageAllowPrefixes: readonly string[];
  secretName: string;
  deadlineSeconds: number;
  runtimeClassName?: string;
}

export function recipientJobName(checkId: string): string {
  return `wr-${checkId}`;
}

export function recipientSecretName(checkId: string): string {
  return `wr-${checkId}-env`;
}

export function buildRecipientJobManifest(input: RecipientJobInput): Record<string, unknown> {
  if (!DIGEST_IMAGE.test(input.image)) throw new ManifestError("image_not_digest_pinned");
  if (!input.imageAllowPrefixes.some((p) => p.length > 0 && input.image.startsWith(p))) throw new ManifestError("image_not_allowed");
  if (!Number.isInteger(input.deadlineSeconds) || input.deadlineSeconds < 10 || input.deadlineSeconds > WARDEN_RECIPE.maxLeaseSeconds) {
    throw new ManifestError("deadline_out_of_range");
  }
  const labels = {
    "paperclip.io/managed-by": "paperclip-k8s-plugin",
    "paperclip.io/check-id": input.checkId,
    "paperclip.io/role": WARDEN_RECIPIENT_ROLE,
    "paperclip.io/recipe": WARDEN_RECIPE.version,
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: recipientJobName(input.checkId), namespace: input.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: input.deadlineSeconds,
      ttlSecondsAfterFinished: 60,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          hostNetwork: false,
          hostPID: false,
          hostIPC: false,
          dnsPolicy: "ClusterFirst",
          ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "recipient",
              image: input.image,
              imagePullPolicy: "IfNotPresent",
              command: ["/usr/bin/node", "/opt/warden-recipient/pod-main.js"],
              terminationMessagePath: "/dev/termination-log",
              terminationMessagePolicy: "File",
              env: [
                { name: "WARDEN_CHECK_ID", value: input.checkId },
                { name: "WARDEN_DEADLINE_MS", value: String((input.deadlineSeconds - 5) * 1000) },
                ...WARDEN_RECIPE.allowedEnvKeys.map((key) => ({
                  name: key,
                  valueFrom: { secretKeyRef: { name: input.secretName, key, optional: false } },
                })),
              ],
              securityContext: {
                runAsNonRoot: true,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: { cpu: "50m", memory: "64Mi" },
                limits: { cpu: "250m", memory: "128Mi" },
              },
            },
          ],
        },
      },
    },
  };
}
