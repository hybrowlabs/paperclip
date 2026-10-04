import { writeFileSync } from "node:fs";
import { runFixedRecipe, WARDEN_RECIPE } from "./recipe.js";
import { createFixedAwsReadPort } from "./sigv4.js";

async function main(): Promise<void> {
  const checkId = process.env.WARDEN_CHECK_ID ?? "";
  const deadlineMs = Math.min(Number(process.env.WARDEN_DEADLINE_MS) || 60_000, WARDEN_RECIPE.maxLeaseSeconds * 1000);
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? "";
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let message: string;
  try {
    const port = createFixedAwsReadPort({
      accessKeyId,
      secretAccessKey,
      fetchImpl: (url, init) => fetch(url, init),
    });
    message = JSON.stringify(await runFixedRecipe(port, checkId, controller.signal));
  } catch {
    message = JSON.stringify({
      v: 1,
      recipe: WARDEN_RECIPE.version,
      checkId,
      expectedPrincipalMatch: "INCONCLUSIVE",
      codebuildProjectFound: "INCONCLUSIVE",
      eksClusterActive: "INCONCLUSIVE",
    });
  } finally {
    clearTimeout(timer);
  }
  writeFileSync("/dev/termination-log", message);
}

void main();
