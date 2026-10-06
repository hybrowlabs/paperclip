import { describe, expect, it } from "vitest";
import {
  SCHEDULED_JOB_FAILURE_THRESHOLD,
  evaluateScheduledJobHealth,
} from "../services/plugin-job-health.js";

function run(jobId: string, status: string, minutesAgo: number, error: string | null = null) {
  return {
    jobId,
    status,
    error,
    createdAt: new Date(Date.UTC(2026, 9, 4, 12, 0) - minutesAgo * 60_000),
  };
}

const JOBS = new Map([
  ["job-a", "inbound-poll"],
  ["job-b", "outbound-delivery-sweep"],
]);

describe("evaluateScheduledJobHealth (HYBA-876)", () => {
  it("defaults the failure threshold to 3", () => {
    expect(SCHEDULED_JOB_FAILURE_THRESHOLD).toBe(3);
  });

  it("passes when there are no runs", () => {
    expect(evaluateScheduledJobHealth([], JOBS)).toMatchObject({
      name: "scheduled_jobs",
      passed: true,
    });
  });

  it("fails when a job's newest runs all failed (100% failure behind a ready plugin)", () => {
    const runs = [
      run("job-a", "failed", 1, "not allowed to perform \"companies.list\""),
      run("job-a", "failed", 2, "x"),
      run("job-a", "failed", 3, "x"),
      run("job-b", "succeeded", 1),
    ];
    const check = evaluateScheduledJobHealth(runs, JOBS);
    expect(check.passed).toBe(false);
    expect(check.message).toContain("inbound-poll");
    expect(check.message).toContain("3 consecutive");
    expect(check.message).toContain("companies.list");
    expect(check.message).not.toContain("outbound-delivery-sweep");
  });

  it("passes below the threshold", () => {
    const runs = [run("job-a", "failed", 1), run("job-a", "failed", 2)];
    expect(evaluateScheduledJobHealth(runs, JOBS).passed).toBe(true);
  });

  it("passes when a success interrupts the failure streak", () => {
    const runs = [
      run("job-a", "failed", 1),
      run("job-a", "succeeded", 2),
      run("job-a", "failed", 3),
      run("job-a", "failed", 4),
    ];
    expect(evaluateScheduledJobHealth(runs, JOBS).passed).toBe(true);
  });

  it("ignores pending and running runs when counting the streak", () => {
    const runs = [
      run("job-a", "running", 0),
      run("job-a", "failed", 1),
      run("job-a", "failed", 2),
      run("job-a", "failed", 3),
    ];
    expect(evaluateScheduledJobHealth(runs, JOBS).passed).toBe(false);
  });

  it("orders runs by creation time regardless of input order", () => {
    const runs = [
      run("job-a", "failed", 3),
      run("job-a", "succeeded", 1),
      run("job-a", "failed", 2),
      run("job-a", "failed", 4),
    ];
    expect(evaluateScheduledJobHealth(runs, JOBS).passed).toBe(true);
  });

  it("names every failing job and falls back to the job id", () => {
    const runs = [
      ...[1, 2, 3].map((m) => run("job-a", "failed", m)),
      ...[1, 2, 3].map((m) => run("job-c", "failed", m)),
    ];
    const check = evaluateScheduledJobHealth(runs, JOBS);
    expect(check.passed).toBe(false);
    expect(check.message).toContain("inbound-poll");
    expect(check.message).toContain("job-c");
  });

  it("truncates a long error and never throws on a null error", () => {
    const long = "e".repeat(2_000);
    const runs = [
      run("job-a", "failed", 1, long),
      run("job-a", "failed", 2, null),
      run("job-a", "failed", 3, null),
    ];
    const check = evaluateScheduledJobHealth(runs, JOBS);
    expect(check.passed).toBe(false);
    expect((check.message ?? "").length).toBeLessThan(600);
  });

  it("honors a custom threshold", () => {
    const runs = [run("job-a", "failed", 1), run("job-a", "failed", 2)];
    expect(evaluateScheduledJobHealth(runs, JOBS, 2).passed).toBe(false);
  });
});
