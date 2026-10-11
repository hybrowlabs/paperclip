import { describe, expect, it } from "vitest";
import { applyAdapterConfigPatch } from "./adapter-config-patch.js";

const REDACTED = "***REDACTED***";
const secretRef = { type: "secret_ref", secretId: "s-1", version: "latest" } as const;
const secretRef2 = { type: "secret_ref", secretId: "s-2", version: "latest" } as const;

describe("applyAdapterConfigPatch (merge)", () => {
  const existing = {
    model: "m1",
    access: { keep: 1 },
    "access.uat_desk_qa_credentials": secretRef,
    env: {
      ANTHROPIC_BASE_URL: { type: "plain", value: "https://real.example" },
      ROOT_PASSWORD: secretRef,
      OTHER: secretRef2,
    },
  };

  it("deletes a single env key when it is set to null and preserves every other entry byte-for-byte", () => {
    const result = applyAdapterConfigPatch(existing, { env: { ROOT_PASSWORD: null } });
    expect(result.env).toEqual({
      ANTHROPIC_BASE_URL: { type: "plain", value: "https://real.example" },
      OTHER: secretRef2,
    });
    expect(JSON.stringify(result)).not.toContain(REDACTED);
    expect(result.model).toBe("m1");
  });

  it("applies set and null entries in one env patch", () => {
    const result = applyAdapterConfigPatch(existing, {
      env: { ROOT_PASSWORD: null, NEW: secretRef2 },
    });
    expect(Object.keys(result.env as object).sort()).toEqual(["ANTHROPIC_BASE_URL", "NEW", "OTHER"]);
  });

  it("keeps legacy wholesale replacement for env when no entry is null", () => {
    const result = applyAdapterConfigPatch(existing, { env: { ONLY: secretRef } });
    expect(result.env).toEqual({ ONLY: secretRef });
  });

  it("deletes a top-level key set to null instead of persisting null", () => {
    const result = applyAdapterConfigPatch(existing, {
      "access.uat_desk_qa_credentials": null,
    });
    expect(Object.prototype.hasOwnProperty.call(result, "access.uat_desk_qa_credentials")).toBe(false);
    expect(result.env).toEqual(existing.env);
    expect(result.model).toBe("m1");
  });

  it("removes a key already stored as a null or literal marker", () => {
    const poisoned = { ...existing, "access.dead": REDACTED };
    const result = applyAdapterConfigPatch(poisoned, { "access.dead": null });
    expect(Object.prototype.hasOwnProperty.call(result, "access.dead")).toBe(false);
  });

  it("leaves keys the caller did not send untouched", () => {
    const result = applyAdapterConfigPatch(existing, { model: "m2" });
    expect(result).toEqual({ ...existing, model: "m2" });
  });

  it("removing an absent env key is a no-op", () => {
    const result = applyAdapterConfigPatch(existing, { env: { NOT_THERE: null } });
    expect(result.env).toEqual(existing.env);
  });

  it("does not mutate its inputs", () => {
    const snapshot = JSON.parse(JSON.stringify(existing));
    applyAdapterConfigPatch(existing, { env: { ROOT_PASSWORD: null }, model: null });
    expect(existing).toEqual(snapshot);
  });
});

describe("applyAdapterConfigPatch (replace)", () => {
  it("drops null entries and does not carry over existing keys", () => {
    const result = applyAdapterConfigPatch(
      { model: "m1", env: { A: secretRef } },
      { cwd: "/x", gone: null, env: { B: secretRef2, C: null } },
      { replace: true },
    );
    expect(result).toEqual({ cwd: "/x", env: { B: secretRef2 } });
  });
});
