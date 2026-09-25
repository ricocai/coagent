/**
 * outbox.test.mjs — 事件回流队列。
 * 覆盖：幂等入队、injected_context 拒绝、flush 提交标记、失败保留现场、
 *       重放不重复、Idempotency-Key 头。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgmClient } from "../../adapter/lib/pgm-client.js";
import { Outbox, makeEvent } from "../../adapter/lib/outbox.js";
import { createMockPgm, TEST_TOKEN } from "./helpers/mock-pgm.mjs";

function freshOutbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "coagent-outbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Outbox({ path: join(dir, "outbox.jsonl") });
}

const ev = (n) =>
  makeEvent({
    projectId: "personal-agent",
    role: "user",
    text: `消息 ${n}`,
    conversationId: "conv-1",
    messageId: `msg-${n}`,
  });

function makeClient(base) {
  return new PgmClient({
    baseUrl: base, token: TEST_TOKEN, projectId: "personal-agent",
    destination: "mtplx", sessionId: "t",
  });
}

test("append 幂等：同 eventKey 不重复入队；injected_context 拒绝", (t) => {
  const box = freshOutbox(t);
  const e = ev(1);
  assert.equal(box.append(e).queued, true);
  assert.equal(box.append(e).queued, false); // 同键跳过
  assert.equal(box.stats().pending, 1);

  const injected = { ...ev(2), origin: "injected_context" };
  assert.throws(() => box.append(injected), /injected_context/);
  assert.equal(box.stats().pending, 1, "注入事件不得入队");
});

test("flush 成功：标记 committed + Idempotency-Key；重放零发送", async (t) => {
  const batches = [];
  const mock = createMockPgm({
    "POST /v1/events:batch": (entry) => {
      batches.push(entry);
      return { body: { results: [], job_id: "j1" } };
    },
  });
  const base = await mock.listen();
  const box = freshOutbox(t);
  box.append(ev(1));
  box.append(ev(2));
  try {
    const r = await box.flush(makeClient(base));
    assert.equal(r.committed.length, 2);
    assert.equal(r.failed, 0);
    assert.equal(box.stats().committed, 2);
    assert.ok(batches[0].headers["idempotency-key"].startsWith("outbox:"));
    assert.equal(batches[0].body.events.length, 2);

    const r2 = await box.flush(makeClient(base)); // 重放：无 pending
    assert.equal(r2.committed.length, 0);
    assert.equal(batches.length, 1, "已提交事件不重发（幂等）");
  } finally {
    await mock.close();
  }
});

test("flush 失败：保留 pending 与 lastError，恢复后重放成功", async (t) => {
  let fail = true;
  const seen = [];
  const mock = createMockPgm({
    "POST /v1/events:batch": (entry) => {
      if (fail) return { status: 503, body: { error: { code: "PGM_UNAVAILABLE", message: "down" } } };
      seen.push(...entry.body.events.map((e) => e.event_id));
      return { body: { results: [], job_id: "j2" } };
    },
  });
  const base = await mock.listen();
  const box = freshOutbox(t);
  box.append(ev(1));
  box.append(ev(2));
  try {
    const r1 = await box.flush(makeClient(base));
    assert.equal(r1.committed.length, 0);
    assert.equal(r1.failed, 2);
    assert.match(r1.lastError, /down/);
    const pend = box.pending();
    assert.equal(pend.length, 2);
    assert.equal(pend[0].attempts, 1);

    fail = false; // 服务恢复
    const r2 = await box.flush(makeClient(base));
    assert.equal(r2.committed.length, 2);
    assert.deepEqual(seen.sort(), ["msg-1", "msg-2"], "恢复后重放且不重复");
  } finally {
    await mock.close();
  }
});

test("outbox 容量上限触发 OUTBOX_FULL", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "coagent-outbox-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const box = new Outbox({ path: join(dir, "ob.jsonl"), maxEntries: 2 });
  box.append(ev(1));
  box.append(ev(2));
  assert.throws(() => box.append(ev(3)), (e) => e.code === "OUTBOX_FULL");
});
