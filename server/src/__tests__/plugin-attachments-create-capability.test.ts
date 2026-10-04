import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES, pluginManifestV1Schema } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

const manifest = (capabilities: string[]) =>
  pluginManifestV1Schema.parse({
    id: "example.relay",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Relay",
    description: "Relays files",
    author: "Example",
    categories: ["connector"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  });

describe("issue.attachments.create capability", () => {
  it("is a known plugin capability", () => {
    expect(PLUGIN_CAPABILITIES).toContain("issue.attachments.create");
  });

  it("is accepted in a manifest", () => {
    const result = pluginCapabilityValidator().validateManifestCapabilities(
      manifest(["issue.attachments.create"]),
    );
    expect(result.allowed).toBe(true);
  });

  it("gates the issue.attachments.create operation: denied with only the read capability, allowed with create", () => {
    const validator = pluginCapabilityValidator();
    expect(
      validator.checkOperation(manifest(["issue.attachments.read"]) as any, "issue.attachments.create").allowed,
    ).toBe(false);
    expect(
      validator.checkOperation(manifest(["issue.attachments.create"]) as any, "issue.attachments.create").allowed,
    ).toBe(true);
  });
});
