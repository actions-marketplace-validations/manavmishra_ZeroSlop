import { readBoundedJson } from "./bounded-json";

export const REQUEST_LEDGER_RETENTION_MS = 48 * 60 * 60 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type LedgerEvent = { id: string; phase: "start" | "finish"; status?: number; modelRequests?: 0 | 1 };
type LedgerRow = { id: string; started_at: number | null; finished_at: number | null; status: number | null; model_requests: number | null; expires_at: number };

export function requestLedgerId(value: unknown): string | null {
  return typeof value === "string" && UUID_V4.test(value) ? value.toLowerCase() : null;
}

export function requestLedgerShard(id: string): string {
  const valid = requestLedgerId(id);
  if (!valid) throw new Error("invalid_request_id");
  return `request-ledger-v1-${(parseInt(valid.slice(0, 2), 16) % 32).toString().padStart(2, "0")}`;
}

export function parseRequestLedgerEvent(value: unknown): LedgerEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !["id", "phase", "status", "modelRequests"].includes(key))) return null;
  if (!("id" in value) || !("phase" in value)) return null;
  const id = requestLedgerId(value.id);
  if (!id || (value.phase !== "start" && value.phase !== "finish")) return null;
  if (value.phase === "start" && ("status" in value || "modelRequests" in value)) return null;
  const result: LedgerEvent = { id, phase: value.phase };
  if ("status" in value) {
    if (typeof value.status !== "number" || !Number.isInteger(value.status) || value.status < 100 || value.status > 599) return null;
    result.status = value.status;
  }
  if ("modelRequests" in value) {
    if (value.modelRequests !== 0 && value.modelRequests !== 1) return null;
    result.modelRequests = value.modelRequests;
  }
  return result;
}

export function receiptIdFromUrl(url: URL): string | null {
  if (url.searchParams.size !== 1 || !url.searchParams.has("id")) return null;
  return requestLedgerId(url.searchParams.get("id"));
}

// Rows identify requests, not people. No input or output text enters this store.
export class RequestLedgerStore {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS request_ledger (
      id TEXT PRIMARY KEY, started_at INTEGER, finished_at INTEGER,
      status INTEGER CHECK(status BETWEEN 100 AND 599),
      model_requests INTEGER CHECK(model_requests IN (0, 1)), expires_at INTEGER NOT NULL
    )`);
    storage.sql.exec("CREATE INDEX IF NOT EXISTS request_ledger_expiry ON request_ledger(expires_at)");
  }

  private row(id: string): LedgerRow | undefined {
    return this.storage.sql.exec<LedgerRow>("SELECT id, started_at, finished_at, status, model_requests, expires_at FROM request_ledger WHERE id = ?", id).toArray()[0];
  }

  cleanup(now = Date.now()): void {
    this.storage.sql.exec("DELETE FROM request_ledger WHERE expires_at <= ?", now);
  }

  async scheduleCleanup(otherDeadline: number | null = null, now = Date.now()): Promise<void> {
    const next = this.storage.sql.exec<{ deadline: number | null }>("SELECT MIN(expires_at) AS deadline FROM request_ledger").one().deadline;
    const candidates = [next, otherDeadline].filter((value): value is number => value !== null);
    if (!candidates.length) return;
    const deadline = Math.max(now + 1, Math.min(...candidates));
    const current = await this.storage.getAlarm();
    if (current === null || current <= now || current > deadline) await this.storage.setAlarm(deadline);
  }

  async record(event: LedgerEvent, now = Date.now()): Promise<Response> {
    // Arm expiration before persisting a new identity. An alarm failure must not
    // leave an idle object retaining receipts without a cleanup deadline.
    await this.scheduleCleanup(now + REQUEST_LEDGER_RETENTION_MS, now);
    const accepted = this.storage.transactionSync(() => {
      this.cleanup(now);
      const current = this.row(event.id);
      if (current) {
        if (event.phase === "start") return current.started_at !== null;
        if (current.finished_at !== null) return current.status === (event.status ?? null)
          && current.model_requests === (event.modelRequests ?? null);
        this.storage.sql.exec("UPDATE request_ledger SET finished_at = ?, status = ?, model_requests = ? WHERE id = ?", now, event.status ?? null, event.modelRequests ?? null, event.id);
      } else {
        this.storage.sql.exec("INSERT INTO request_ledger(id, started_at, finished_at, status, model_requests, expires_at) VALUES (?, ?, ?, ?, ?, ?)", event.id, event.phase === "start" ? now : null, event.phase === "finish" ? now : null, event.status ?? null, event.modelRequests ?? null, now + REQUEST_LEDGER_RETENTION_MS);
      }
      return true;
    });
    return accepted ? new Response(null, { status: 204 }) : Response.json({ error: "request_event_conflict" }, { status: 409 });
  }

  receipt(id: string, now = Date.now()): Response {
    this.cleanup(now);
    const row = this.row(id);
    if (!row) return Response.json({ schema: 1, id, state: "notfound" }, { status: 404 });
    return Response.json({
      schema: 1, id,
      state: row.started_at === null ? "orphan" : row.finished_at === null ? "pending" : "complete",
      startedAt: row.started_at === null ? null : new Date(row.started_at).toISOString(),
      finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
      status: row.status, modelRequests: row.model_requests,
      expiresAt: new Date(row.expires_at).toISOString(),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/request-ledger/event") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      let input: unknown;
      try { input = await readBoundedJson(new Response(request.body, { headers: request.headers }), 1024); }
      catch { return Response.json({ error: "invalid_request_event" }, { status: 400 }); }
      const event = parseRequestLedgerEvent(input);
      if (!event || url.search) return Response.json({ error: "invalid_request_event" }, { status: 400 });
      return this.record(event);
    }
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
    const id = receiptIdFromUrl(url);
    if (!id) return Response.json({ error: "invalid_request_id" }, { status: 400 });
    return this.receipt(id);
  }
}
