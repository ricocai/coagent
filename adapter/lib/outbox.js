/**
 * outbox.js — 事件回流本地待发送队列（§8.3）。
 *
 * 职责：回流失败时落盘、显示待同步、恢复后幂等重放。
 * 边界：它是待发送队列，不是第二套长期记忆（§8.3）。
 *
 * 存储：JSONL，每行一条记录：
 *   { eventKey, status: pending|committed, attempts, lastError, event, createdAt, committedAt }
 *
 * 幂等（§8.3/PGM §6.2）：
 *  - eventKey 由客户端生成且稳定 = connector|accountRef|conversationId|messageId|revision
 *    （与服务端 source_key 同构）；
 *  - 收到 PGM 2xx 持久化回执后才标记 committed；
 *  - 重启重放同一 eventKey 不产生重复事件（服务端按 source_key 幂等）。
 *  - 批次 Idempotency-Key = "outbox:" + 首条 eventKey + ":" + 批内 eventKey 数，
 *    便于服务端 job 审计。
 */

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";

/** 注入材料不得回流（§8.2 防回流污染）。 */
export class InjectedContextError extends Error {
  constructor(eventKey) {
    super(`拒绝回流 origin=injected_context 的事件: ${eventKey}`);
    this.name = "InjectedContextError";
  }
}

/** 容量上限（默认 5000 条）：防失控积压；触顶后拒绝新事件并要求人工处理。 */
export const DEFAULT_MAX_ENTRIES = 5000;

export function makeEventKey(ev) {
  const s = ev.source;
  return `${s.connector}|${s.account_ref}|${s.conversation_id}|${s.message_id}|${s.revision ?? "1"}`;
}

export function makeEvent({
  projectId,
  role,
  text,
  conversationId,
  messageId,
  connector = "dsh-harness",
  accountRef = "local",
  revision = "1",
  origin = "native",
  classification = "personal",
  occurredAt,
  derivedFrom = [],
}) {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("makeEvent: text 不能为空");
  }
  if (!messageId) throw new Error("makeEvent: messageId 必填（幂等键的一部分）");
  return {
    schema_version: "pgm.event.v1",
    event_id: messageId,
    source: {
      connector,
      account_ref: accountRef,
      conversation_id: conversationId ?? messageId,
      message_id: messageId,
      revision,
      coverage: "complete_for_export",
    },
    project_id: projectId,
    role,
    content: [{ type: "text", text }],
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
    ingested_at: new Date().toISOString(),
    classification,
    origin,
    derived_from: derivedFrom,
  };
}

export class Outbox {
  /**
   * @param {object} opts
   * @param {string} opts.path       JSONL 文件路径（state 目录，不进 Git）
   * @param {number} [opts.maxEntries]
   */
  constructor({ path, maxEntries = DEFAULT_MAX_ENTRIES }) {
    this.path = path;
    this.maxEntries = maxEntries;
    mkdirSync(dirname(path), { recursive: true });
  }

  /** 全量读入（POC 规模可用；未来量大再改增量游标）。 */
  _load() {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  }

  _saveAll(records) {
    const tmp = `${this.path}.tmp`;
    const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
    // 写临时文件后原子替换，避免进程中断产生半行
    writeFileSync(tmp, body);
    renameSync(tmp, this.path);
  }

  _append(record) {
    appendFileSync(this.path, JSON.stringify(record) + "\n");
  }

  /**
   * 入队一条 pgm.event.v1 事件。同 eventKey 已存在（任意状态）时幂等跳过。
   * @returns {{queued: boolean, eventKey: string}}
   */
  append(event) {
    if (event.origin === "injected_context") {
      throw new InjectedContextError(makeEventKey(event));
    }
    const eventKey = makeEventKey(event);
    const records = this._load();
    if (records.some((r) => r.eventKey === eventKey)) {
      return { queued: false, eventKey };
    }
    if (records.length >= this.maxEntries) {
      const err = new Error(
        `outbox 已满（${records.length}/${this.maxEntries}），请先处理积压或调大容量`,
      );
      err.code = "OUTBOX_FULL";
      throw err;
    }
    this._append({
      eventKey,
      status: "pending",
      attempts: 0,
      lastError: null,
      event,
      createdAt: new Date().toISOString(),
      committedAt: null,
    });
    return { queued: true, eventKey };
  }

  stats() {
    const records = this._load();
    const by = { pending: 0, committed: 0 };
    for (const r of records) by[r.status] = (by[r.status] ?? 0) + 1;
    return { total: records.length, ...by, path: this.path };
  }

  pending() {
    return this._load().filter((r) => r.status === "pending");
  }

  /**
   * 重放 pending 事件（恢复后调用）。逐批发送，2xx 才标记 committed。
   * @param {object} client PgmClient
   * @param {{batchSize?: number, maxBatches?: number}} [opts]
   * @returns {{committed: string[], failed: number, lastError: string|null}}
   */
  async flush(client, { batchSize = 20, maxBatches = 50 } = {}) {
    const committed = [];
    let failed = 0;
    let lastError = null;

    for (let b = 0; b < maxBatches; b++) {
      const pend = this.pending();
      if (pend.length === 0) break;
      const batch = pend.slice(0, batchSize);
      const events = batch.map((r) => r.event);
      const idempotencyKey = `outbox:${batch[0].eventKey}:${batch.length}`;
      try {
        await client.pushEvents(events, { idempotencyKey });
        this._markCommitted(batch.map((r) => r.eventKey));
        committed.push(...batch.map((r) => r.eventKey));
      } catch (err) {
        lastError = err.message;
        this._markFailed(batch.map((r) => r.eventKey), err.message);
        failed += batch.length;
        break; // 首个失败批次即停，保留现场等待恢复
      }
    }
    return { committed, failed, lastError };
  }

  _markCommitted(eventKeys) {
    const records = this._load();
    const set = new Set(eventKeys);
    for (const r of records) {
      if (set.has(r.eventKey) && r.status === "pending") {
        r.status = "committed";
        r.committedAt = new Date().toISOString();
      }
    }
    this._saveAll(records);
  }

  _markFailed(eventKeys, message) {
    const records = this._load();
    const set = new Set(eventKeys);
    for (const r of records) {
      if (set.has(r.eventKey) && r.status === "pending") {
        r.attempts += 1;
        r.lastError = message;
      }
    }
    this._saveAll(records);
  }
}

export function batchHash(events) {
  return createHash("sha256").update(JSON.stringify(events)).digest("hex");
}
