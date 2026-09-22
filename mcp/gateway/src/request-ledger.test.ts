import assert from "node:assert/strict";
import test from "node:test";
import { parseRequestLedgerEvent, requestLedgerId, requestLedgerShard } from "./request-ledger";

const id = "ff000000-0000-4000-8000-000000000000";
test("ledger ids are UUIDv4 and map deterministically to exactly 32 shards", () => {
  assert.equal(requestLedgerId(id.toUpperCase()), id);
  assert.equal(requestLedgerId("ff000000-0000-1000-8000-000000000000"), null);
  assert.equal(requestLedgerShard(id), "request-ledger-v1-31");
  const shards = new Set(Array.from({ length: 256 }, (_, byte) => requestLedgerShard(`${byte.toString(16).padStart(2, "0")}000000-0000-4000-8000-000000000000`)));
  assert.equal(shards.size, 32);
  assert.throws(() => requestLedgerShard("caller-chosen"));
});
test("ledger events reject unknown or phase-inappropriate fields and invalid values", () => {
  assert.deepEqual(parseRequestLedgerEvent({ id, phase: "start" }), { id, phase: "start" });
  assert.deepEqual(parseRequestLedgerEvent({ id, phase: "finish", status: 200, modelRequests: 1 }), { id, phase: "finish", status: 200, modelRequests: 1 });
  assert.deepEqual(parseRequestLedgerEvent({ id, phase: "finish", status: 200, modelRequests: 2 }), { id, phase: "finish", status: 200, modelRequests: 2 });
  for (const input of [null, [], { id, phase: "start", text: "private" }, { id, phase: "start", status: 200 }, { id, phase: "finish", status: 99 }, { id, phase: "finish", status: 600 }, { id, phase: "finish", modelRequests: 3 }, { id, phase: "finish", status: "200" }, { id, phase: "finish", modelRequests: null }]) assert.equal(parseRequestLedgerEvent(input), null);
});
