import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { postgres } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pgChannelForCompany } from "../services/live-events/channel.js";
import { createPgLiveEventsTransport } from "../services/live-events/pg-transport.js";
import {
  configureLiveEventsTransport,
  getLiveEventsTransportHealth,
  publishLiveEvent,
  subscribeCompanyLiveEvents,
  teardownLiveEventsTransport,
  whenTransportSubscribed,
} from "../services/live-events.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping cross-replica live-events tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function makeEvent(overrides: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: 1,
    companyId: "company-a",
    type: "activity.logged",
    createdAt: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

async function waitFor<T>(fn: () => T | undefined, { timeoutMs = 5000, intervalMs = 25 } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined && value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timed out");
}

describeEmbeddedPostgres("live-events postgres LISTEN/NOTIFY transport", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let databaseUrl = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-events-");
    databaseUrl = tempDb.connectionString;
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("delivers a NOTIFY published on replica A to a LISTEN on replica B (different originIds)", async () => {
    const replicaA = createPgLiveEventsTransport({ databaseUrl });
    const replicaB = createPgLiveEventsTransport({ databaseUrl });
    expect(replicaA.originId).not.toBe(replicaB.originId);

    const receivedOnB: LiveEvent[] = [];
    replicaB.subscribe("company-a", (event) => receivedOnB.push(event));
    // Wait for LISTEN to settle before publishing — postgres-js does it on
    // a dedicated socket and returns a meta handle asynchronously.
    await replicaB.whenSubscribed!("company-a");

    const event = makeEvent({ id: 101, payload: { hello: "world" } });
    replicaA.publish(event);

    const got = await waitFor(() => (receivedOnB.length > 0 ? receivedOnB[0] : undefined));
    expect(got.id).toBe(101);
    expect(got.payload).toEqual({ hello: "world" });

    await replicaA.close();
    await replicaB.close();
  });

  it("drops self-echoes via originId filter (single replica subscribing to its own channel)", async () => {
    const replica = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    replica.subscribe("company-a", (e) => received.push(e));
    await replica.whenSubscribed!("company-a");

    replica.publish(makeEvent({ id: 202 }));
    // Negative assertion: there is no readiness signal for "the echo would
    // have arrived by now", so give NOTIFY a generous round-trip window.
    await new Promise((r) => setTimeout(r, 500));

    // The same replica published it; the originId filter should drop it
    // so we don't double-emit (the local publishLiveEvent already
    // emitted the event in-process at the higher level).
    expect(received).toEqual([]);
    await replica.close();
  });

  it("isolates traffic across companies — a replica subscribed to A only never sees B's NOTIFY", async () => {
    const publisher = createPgLiveEventsTransport({ databaseUrl });
    const subscriberA = createPgLiveEventsTransport({ databaseUrl });
    const seenByA: LiveEvent[] = [];
    subscriberA.subscribe("company-a", (e) => seenByA.push(e));
    await subscriberA.whenSubscribed!("company-a");

    publisher.publish(makeEvent({ id: 301, companyId: "company-b", payload: { secret: "do-not-leak" } }));
    publisher.publish(makeEvent({ id: 302, companyId: "company-a" }));

    const got = await waitFor(() => (seenByA.length > 0 ? seenByA[0] : undefined));
    expect(got.id).toBe(302);
    expect(got.companyId).toBe("company-a");
    // Negative assertion with no readiness signal: give B's NOTIFY a
    // generous window to (incorrectly) arrive.
    await new Promise((r) => setTimeout(r, 500));
    expect(seenByA.some((e) => e.companyId === "company-b")).toBe(false);

    await publisher.close();
    await subscriberA.close();
  });

  it("integrates with publishLiveEvent / subscribeCompanyLiveEvents through configureLiveEventsTransport", async () => {
    await configureLiveEventsTransport({ mode: "postgres", databaseUrl });
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("company-a", (e) => received.push(e));
    await whenTransportSubscribed("company-a");

    // In a single-process test the in-process emitter delivers the
    // event immediately; the cross-replica path also fires through pg
    // but originId filter drops the echo. We just verify the in-process
    // delivery still works after the transport is installed.
    publishLiveEvent({ companyId: "company-a", type: "activity.logged" });
    expect(received).toHaveLength(1);

    unsubscribe();
    await teardownLiveEventsTransport();
  });

  it("rebinds subscribers that attached before configureLiveEventsTransport (boot race)", async () => {
    // Reproduces the boot race that greptile flagged: a WS handler
    // subscribes during server startup while configureLiveEventsTransport
    // is still resolving. Before the fix, attachTransportFor short-
    // circuited on `!transport` and never recorded the subscriber, so
    // rebindExistingSubscriptions later iterated an empty map and the
    // subscriber missed cross-replica events for its lifetime.
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("company-a", (e) => received.push(e));

    // Configure the transport AFTER the subscription is already in place.
    await configureLiveEventsTransport({ mode: "postgres", databaseUrl });
    // LISTEN is async; wait for postgres-js to settle it.
    await whenTransportSubscribed("company-a");

    // Publish from an independent replica so the in-process path is not
    // involved — delivery must come exclusively through LISTEN/NOTIFY.
    const replicaA = createPgLiveEventsTransport({ databaseUrl });
    replicaA.publish(makeEvent({ id: 9001, payload: { boot: "race" } }));

    const got = await waitFor(() => received.find((e) => e.id === 9001));
    expect(got.id).toBe(9001);
    expect(got.payload).toEqual({ boot: "race" });

    unsubscribe();
    await replicaA.close();
    await teardownLiveEventsTransport();
  });

  it("coalesces a burst into batch envelopes and delivers all events", async () => {
    const sender = createPgLiveEventsTransport({ databaseUrl });
    const receiver = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    receiver.subscribe("company-a", (event) => received.push(event));
    await receiver.whenSubscribed!("company-a");

    // Raw frame observer: a plain postgres-js LISTEN on the same channel
    // records the wire envelopes, so we can assert the burst actually
    // coalesced into fewer frames rather than 20 one-event NOTIFYs.
    const rawSql = postgres(databaseUrl, { max: 1 });
    const frames: { kind?: string }[] = [];
    await rawSql.listen(pgChannelForCompany("company-a"), (raw) => frames.push(JSON.parse(raw)));

    for (let i = 1; i <= 20; i++) sender.publish(makeEvent({ id: i }));
    await waitFor(() => (received.length === 20 ? received : undefined));
    expect(received.map((e) => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    // The raw listener is a separate connection; wait until it has seen a
    // batch frame before asserting on counts.
    await waitFor(() => (frames.some((f) => f.kind === "batch") ? true : undefined));
    expect(frames.length).toBeLessThan(20);

    await rawSql.end({ timeout: 5 });
    await sender.close();
    await receiver.close();
  });

  it("survives a malformed NOTIFY envelope and keeps the LISTEN connection alive", async () => {
    const receiver = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    receiver.subscribe("company-a", (event) => received.push(event));
    await receiver.whenSubscribed!("company-a");

    // Inject valid JSON with an unknown kind straight onto the channel.
    // Before envelopeToEvents was total, this returned undefined and the
    // resulting `for ... of undefined` TypeError propagated into
    // postgres-js's onnotify dispatch, killing the LISTEN connection.
    const rawSql = postgres(databaseUrl, { max: 1 });
    await rawSql.notify(
      pgChannelForCompany("company-a"),
      JSON.stringify({ origin: "other", kind: "bogus" }),
    );

    // A well-formed event published afterwards must still arrive — that
    // proves the malformed frame was dropped and the LISTEN survived.
    const sender = createPgLiveEventsTransport({ databaseUrl });
    sender.publish(makeEvent({ id: 707 }));
    const got = await waitFor(() => received.find((e) => e.id === 707));
    expect(got.id).toBe(707);
    // Nothing was delivered for the bogus frame (and no synthetic resync
    // from a reconnect either — the connection never dropped).
    expect(received.map((e) => e.id)).toEqual([707]);

    await rawSql.end({ timeout: 5 });
    await sender.close();
    await receiver.close();
  });

  it("delivers a resync marker for an oversized event instead of dropping it", async () => {
    const sender = createPgLiveEventsTransport({ databaseUrl });
    const receiver = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    receiver.subscribe("company-a", (event) => received.push(event));
    await receiver.whenSubscribed!("company-a");
    sender.publish(makeEvent({ type: "heartbeat.run.log", payload: { huge: "x".repeat(10_000) } }));
    const marker = await waitFor(() => received[0]);
    expect(marker.type).toBe("heartbeat.run.log");
    expect(marker.payload).toEqual({ __resync: true });
    await sender.close();
    await receiver.close();
  });

  it("does not duplicate delivery after unsubscribe→resubscribe while LISTEN is in flight", async () => {
    const receiver = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    const handler = (e: LiveEvent) => received.push(e);
    // All three calls land within one LISTEN round-trip: the first LISTEN
    // is still in flight when its subscription record is deleted and a new
    // one is seated. Without the identity guard, listen #1's callback
    // stayed registered forever and every NOTIFY was delivered twice.
    receiver.subscribe("company-a", handler);
    receiver.unsubscribe("company-a", handler);
    receiver.subscribe("company-a", handler);
    await receiver.whenSubscribed!("company-a");

    const sender = createPgLiveEventsTransport({ databaseUrl });
    sender.publish(makeEvent({ id: 808 }));
    await waitFor(() => received.find((e) => e.id === 808));
    // Negative assertion (no signal for "the duplicate would have arrived
    // by now"): both callbacks fire from the same NOTIFY dispatch, so a
    // short settle is enough for the duplicate to show up if it exists.
    await new Promise((r) => setTimeout(r, 200));
    expect(received.map((e) => e.id)).toEqual([808]);

    await sender.close();
    await receiver.close();
  });

  it("close() flushes pending coalesced events", async () => {
    const sender = createPgLiveEventsTransport({ databaseUrl });
    const receiver = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    receiver.subscribe("company-a", (event) => received.push(event));
    await receiver.whenSubscribed!("company-a");
    sender.publish(makeEvent({ id: 42 }));
    await sender.close(); // before the 25ms window elapses
    const event = await waitFor(() => received[0]);
    expect(event.id).toBe(42);
    await receiver.close();
  });

  it("reports notification queue usage via stats()", async () => {
    const transport = createPgLiveEventsTransport({ databaseUrl });
    const stats = await transport.stats!();
    expect(stats.notificationQueueUsage).toBeGreaterThanOrEqual(0);
    expect(stats.notificationQueueUsage).toBeLessThan(1);
    await transport.close();
  });

  it("reports transport health with queue usage when the pg transport is active", async () => {
    await teardownLiveEventsTransport();
    expect(await getLiveEventsTransportHealth()).toEqual({ mode: "in-process" });
    await configureLiveEventsTransport({ mode: "postgres", databaseUrl });
    const health = await getLiveEventsTransportHealth();
    expect(health.mode).toBe("transport");
    if (health.mode === "transport") {
      expect(health.originId).toBeTruthy();
      expect(health.notificationQueueUsage).toBeGreaterThanOrEqual(0);
      expect(health.notificationQueueUsage).toBeLessThan(1);
    }
    await teardownLiveEventsTransport();
  });

  it("routes transport.resync markers to company subscribers through the emitter", async () => {
    await configureLiveEventsTransport({ mode: "postgres", databaseUrl });
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("company-resync", (e) => received.push(e));
    await whenTransportSubscribed("company-resync");
    publishLiveEvent({ companyId: "company-resync", type: "transport.resync", payload: { __resync: true } });
    const event = await waitFor(() => received.find((e) => e.type === "transport.resync"));
    expect(event.payload).toEqual({ __resync: true });
    unsubscribe();
    await teardownLiveEventsTransport();
  });
});

describe("live-events transport=off", () => {
  afterEach(async () => {
    await teardownLiveEventsTransport();
  });

  it("publishes in-process events without attempting cross-replica fan-out", async () => {
    await configureLiveEventsTransport({ mode: "off" });
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("company-a", (e) => received.push(e));
    publishLiveEvent({ companyId: "company-a", type: "activity.logged" });
    expect(received).toHaveLength(1);
    unsubscribe();
  });
});
