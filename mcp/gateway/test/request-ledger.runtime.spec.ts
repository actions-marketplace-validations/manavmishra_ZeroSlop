import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject, createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { RequestLedgerStore, requestLedgerShard } from "../src/request-ledger";

const secret = Array.from({ length: 8 }, (_, index) => `test-part-${index}`).join("-");
function setup() {
  const id = crypto.randomUUID();
  const stub = env.MCP_COUNTER.getByName(requestLedgerShard(id));
  const event = async (phase: string, extra = {}) => {
    const response = await stub.fetch("https://counter.internal/request-ledger/event", { method: "POST", body: JSON.stringify({ id, phase, ...extra }) });
    await response.text();
    return response;
  };
  const receipt = () => stub.fetch(`https://counter.internal/request-ledger/receipt?id=${id}`);
  return { id, stub, event, receipt };
}
describe("durable request ledger", () => {
  it("migrates old receipts before recording a two-provider request", async () => {
    const stub = env.MCP_COUNTER.getByName(`ledger-upgrade-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const oldId = crypto.randomUUID();
      state.storage.sql.exec("DROP TABLE IF EXISTS request_ledger");
      state.storage.sql.exec(`CREATE TABLE request_ledger (
        id TEXT PRIMARY KEY, started_at INTEGER, finished_at INTEGER,
        status INTEGER CHECK(status BETWEEN 100 AND 599),
        model_requests INTEGER CHECK(model_requests IN (0, 1)), expires_at INTEGER NOT NULL
      )`);
      state.storage.sql.exec("INSERT INTO request_ledger VALUES (?, ?, ?, 200, 1, ?)", oldId, Date.now() - 1000, Date.now(), Date.now() + 60_000);
      const ledger = new RequestLedgerStore(state.storage);
      expect((await ledger.receipt(oldId).json()).modelRequests).toBe(1);
      const nextId = crypto.randomUUID();
      expect((await ledger.record({ id: nextId, phase: "start" })).status).toBe(204);
      expect((await ledger.record({ id: nextId, phase: "finish", status: 200, modelRequests: 2 })).status).toBe(204);
      expect((await ledger.receipt(nextId).json()).modelRequests).toBe(2);
      expect(new RequestLedgerStore(state.storage)).toBeDefined();
    });
  });
  it("deduplicates concurrent events, rejects contradictory finishes, and survives eviction", async () => {
    const { stub, event, receipt } = setup();
    const missing = await receipt();
    expect(missing.status).toBe(404);
    await missing.text();
    expect((await Promise.all(Array.from({ length: 30 }, () => event("start")))).every((r) => r.status === 204)).toBe(true);
    const pending = await (await receipt()).json<{ startedAt: string; expiresAt: string }>();
    expect(pending).toMatchObject({ state: "pending", finishedAt: null });
    expect((await Promise.all(Array.from({ length: 30 }, () => event("finish", { status: 200, modelRequests: 1 })))).every((r) => r.status === 204)).toBe(true);
    const complete = await (await receipt()).json();
    expect(complete).toMatchObject({ state: "complete", status: 200, modelRequests: 1 });
    expect(complete).toMatchObject({ startedAt: pending.startedAt, expiresAt: pending.expiresAt });
    expect((await event("finish", { status: 500, modelRequests: 1 })).status).toBe(409);
    await evictDurableObject(stub);
    expect(await (await receipt()).json()).toEqual(complete);
  });
  it("accepts exactly one of two contradictory concurrent finishes", async () => {
    const { event, receipt } = setup();
    await event("start");
    const responses = await Promise.all([event("finish", { status: 200, modelRequests: 1 }), event("finish", { status: 503, modelRequests: 0 })]);
    expect(responses.map((response) => response.status).sort()).toEqual([204, 409]);
    expect(await (await receipt()).json()).toMatchObject({ state: "complete" });
  });
  it("does not turn an orphan into a verified receipt", async () => {
    const { event, receipt } = setup();
    expect((await event("finish", { status: 503, modelRequests: 0 })).status).toBe(204);
    expect((await event("start")).status).toBe(409);
    expect(await (await receipt()).json()).toMatchObject({ state: "orphan", startedAt: null, status: 503 });
  });
  it("rejects oversized and unknown input without storing private fields", async () => {
    const { id, stub, receipt } = setup();
    for (const body of [JSON.stringify({ id, phase: "start", text: "private" }), JSON.stringify({ id, phase: "start" }) + " ".repeat(1024)]) {
      expect((await stub.fetch("https://counter.internal/request-ledger/event", { method: "POST", body })).status).toBe(400);
    }
    expect((await receipt()).status).toBe(404);
  });
  it("expires receipts on reads and alarms while preserving current budget and counters", async () => {
    const { id, stub, event, receipt } = setup();
    await event("start");
    const day = new Date().toISOString().slice(0, 10);
    expect((await stub.fetch("https://counter.internal/reserve-editor", { method: "POST", body: JSON.stringify({ day, clientKey: "b".repeat(64), neurons: 1 }) })).status).toBe(200);
    const alarmOnlyId = crypto.randomUUID();
    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql.exec<{ expires_at: number; started_at: number }>("SELECT expires_at, started_at FROM request_ledger WHERE id = ?", id).one();
      expect(row.expires_at - row.started_at).toBe(48 * 60 * 60 * 1000);
      state.storage.sql.exec("UPDATE request_ledger SET expires_at = ? WHERE id = ?", Date.now() - 1, id);
      state.storage.sql.exec("INSERT OR REPLACE INTO counters(name, value) VALUES ('mcp_tool_calls', 7)");
      expect(state.storage.sql.exec<{ name: string }>("PRAGMA table_info(request_ledger)").toArray().map((column) => column.name)).toEqual(["id", "started_at", "finished_at", "status", "model_requests", "expires_at"]);
    });
    expect((await receipt()).status).toBe(404);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO request_ledger(id, started_at, expires_at) VALUES (?, ?, ?)", alarmOnlyId, Date.now() - 2000, Date.now() - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT id FROM request_ledger WHERE id = ?", id).toArray()).toHaveLength(0);
      expect(state.storage.sql.exec<{ value: number }>("SELECT value FROM counters WHERE name = 'mcp_tool_calls'").one().value).toBe(7);
      expect(state.storage.sql.exec("SELECT id FROM request_ledger WHERE id = ?", alarmOnlyId).toArray()).toHaveLength(0);
      expect(state.storage.sql.exec("SELECT day FROM editor_budget_days WHERE day = ?", day).toArray()).toHaveLength(1);
      expect(await state.storage.getAlarm()).toBe((Math.floor(Date.now() / 86400000) + 1) * 86400000);
    });
  });
  it("does not persist identities when expiration cannot be scheduled", async () => {
    const stub = env.MCP_COUNTER.getByName(`ledger-alarm-failure-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = new Proxy(state.storage, { get(target, key) {
        if (key === "setAlarm") return async () => { throw new Error("alarm unavailable"); };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const ledger = new RequestLedgerStore(storage);
      await expect(ledger.record({ id: crypto.randomUUID(), phase: "start" })).rejects.toThrow("alarm unavailable");
      expect(state.storage.sql.exec("SELECT id FROM request_ledger").toArray()).toHaveLength(0);
    });
  });
  it("authenticates public receipt reads and never exposes internal event writes", async () => {
    const { id, event } = setup();
    await event("start");
    const read = (path: string, token?: string, method = "GET") => worker.fetch(new Request(`https://mcp.zero-slop.ai${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }), env, createExecutionContext());
    expect((await read(`/metrics/request?id=${id}`)).status).toBe(401);
    expect((await read(`/metrics/request?id=${id}`, "wrong")).status).toBe(401);
    const allowed = await read(`/metrics/request?id=${id}`, secret);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect(await allowed.json()).toMatchObject({ id, state: "pending" });
    expect((await read(`/metrics/request?id=${id}&shard=elsewhere`, secret)).status).toBe(400);
    expect((await read(`/metrics/request?id=${id}`, secret, "POST")).status).toBe(405);
    expect((await read("/request-ledger/event", secret, "POST")).status).toBe(404);
  });
});
