import { describe, expect, it } from "vitest";
import { resolveLiveEventsDatabaseUrl } from "../services/live-events.js";

describe("resolveLiveEventsDatabaseUrl", () => {
  it("uses PAPERCLIP_LIVE_EVENTS_DATABASE_URL when set", () => {
    expect(
      resolveLiveEventsDatabaseUrl(
        { PAPERCLIP_LIVE_EVENTS_DATABASE_URL: " postgres://app@direct/db " } as NodeJS.ProcessEnv,
        "postgres://app@pooled/db",
      ),
    ).toBe("postgres://app@direct/db");
  });

  it("falls back to the application connection string", () => {
    expect(resolveLiveEventsDatabaseUrl({} as NodeJS.ProcessEnv, "postgres://app@pooled/db")).toBe(
      "postgres://app@pooled/db",
    );
  });

  it("never uses the DDL-capable DATABASE_MIGRATION_URL", () => {
    expect(
      resolveLiveEventsDatabaseUrl(
        { DATABASE_MIGRATION_URL: "postgres://migrator@direct/db" } as NodeJS.ProcessEnv,
        "postgres://app@pooled/db",
      ),
    ).toBe("postgres://app@pooled/db");
  });
});
