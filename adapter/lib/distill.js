/**
 * distill.js — 事件 → 候选记忆 提炼管线（设计 §11.7 / §5.2 / §12.5）。
 *
 * 职责：把 outbox 中已 committed 的用户事件，经本地模型（MTPLX，纯对话、
 * 无执行工具）抽取为结构化候选记忆，经 POST /v1/proposals 提交为候选。
 *
 * 设计硬约束（不可妥协）：
 *  - §11.7 候选抽取只走本地模型（MTPLX；LM Studio 备用），禁止自动云端回退；
 *    模型端点非回环地址时默认拒绝（--allow-remote 显式越过，仅限调试）。
 *  - 抽取调用不带任何 tools 字段：提炼器无执行能力（§11.7「无执行工具」）。
 *  - 只采 role=user 的事件：助手消息是建议不是决定（§12.5 角色测试）。
 *  - 只产生候选（propose），绝不改变确认状态（§5.2）；审批权在用户。
 *  - 候选 classification 取来源事件的最敏感级别（local_only 优先），
 *    且抽取前对模型输出内容做二次脱敏（纵深防御，session-capture.redact 复用）。
 *
 * 幂等：本地 ledger（JSONL 两阶段）：
 *  - propose 前先写 {phase:"pending", distillKey}；成功后追加 {phase:"committed", proposalId}。
 *  - 重跑时 pending 的 distillKey 默认跳过（宁可漏提不重提——重复候选会污染确认收件箱）；
 *    确认 propose 实际失败后用 --retry-pending 重处理。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./session-capture.js";

export const MEMORY_TYPES = [
  "decision",
  "fact",
  "preference",
  "procedure",
  "episode",
  "project_state",
  "todo",
];

const CLASSIFICATION_RANK = { public: 0, personal: 1, local_only: 2, secret_excluded: 3 };

/** 回环地址判定（§11.7 禁止自动云端回退的实现基础）。 */
export function isLoopbackUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

export class DistillConfigError extends Error {}

/**
 * 从 outbox 记录中筛选待提炼事件。
 * @param {Array} records outbox JSONL 记录
 * @param {{ledgerKeys: Set<string>, projectId?: string, limit?: number}} opts
 * @returns {Array<{record, eventKey}>}
 */
export function selectEvents(records, { ledgerKeys, projectId, limit = Infinity } = {}) {
  const out = [];
  for (const r of records) {
    if (r.status !== "committed" || !r.event) continue;
    const ev = r.event;
    if (ev.origin === "injected_context") continue; // 双保险（§8.2）
    if (ev.role !== "user") continue; // 角色测试：只信真人输入
    if (projectId && ev.project_id !== projectId) continue;
    const text = ev.content?.[0]?.text ?? "";
    if (!text.trim()) continue;
    if (ledgerKeys.has(r.eventKey)) continue; // 已提炼
    out.push({ record: r, eventKey: r.eventKey });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 按总字符数分批（每批一次模型调用）。
 * @returns {Array<Array<{record, eventKey}>>}
 */
export function batchEvents(items, { maxChars = 3000 } = {}) {
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    const len = (it.record.event.content?.[0]?.text ?? "").length;
    if (cur.length && chars + len > maxChars) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** 构造提炼 prompt（中文、严格 JSON、宁缺毋滥）。 */
export function buildExtractionPrompt(batch) {
  const lines = batch.map((it, i) => {
    const ev = it.record.event;
    return `[${i}] (${ev.event_id}) ${ev.content?.[0]?.text ?? ""}`;
  });
  return [
    "你是记忆提炼器。从下面的用户消息中抽取值得长期保存的候选记忆。",
    "",
    "规则：",
    `- 只输出一个 JSON 数组，不要输出任何其它文字、注释或代码围栏。`,
    `- 每项形如 {"type":"...","content":"...","evidence":[索引,...]}。`,
    `- type 只能取：${MEMORY_TYPES.join("|")}。`,
    "- content 是一句完整的中文陈述（≤200 字），必须是用户明确表达的决定/事实/偏好/待办，不得复制大段原文，不得包含密钥或令牌。",
    "- evidence 引用消息索引（从 0 开始）。",
    "- 用户只是询问、闲聊或没有明确结论的内容一律不抽取；宁缺毋滥，可为空数组 []。",
    "",
    "用户消息：",
    ...lines,
  ].join("\n");
}

/**
 * 解析并校验模型输出 → 候选数组。
 * @returns {Array<{type, content, evidenceIds: string[]}>}
 * @throws {Error} 输出完全不可解析时抛出（由调用方决定重试/跳过）
 */
export function parseModelOutput(raw, batch) {
  let text = String(raw ?? "").trim();
  // 容错：剥掉代码围栏
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    // 容错：截取首个 '[' 到最后一个 ']'
    const s = text.indexOf("[");
    const e = text.lastIndexOf("]");
    if (s === -1 || e <= s) throw new Error(`模型输出不是 JSON 数组: ${text.slice(0, 120)}`);
    arr = JSON.parse(text.slice(s, e + 1));
  }
  if (!Array.isArray(arr)) throw new Error("模型输出不是 JSON 数组");

  const candidates = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const { type, content, evidence } = item;
    if (!MEMORY_TYPES.includes(type)) continue; // 非法类型直接丢弃
    if (typeof content !== "string") continue;
    const { text: clean } = redact(content); // 二次脱敏（纵深防御）
    const body = clean.trim();
    if (!body || body.length > 500) continue;
    const idxs = Array.isArray(evidence) ? evidence : [];
    const evidenceIds = [];
    for (const i of idxs) {
      const it = batch[Number(i)];
      if (it && Number.isInteger(Number(i)) && Number(i) >= 0) {
        evidenceIds.push(it.record.event.event_id);
      }
    }
    // 敏感度取来源事件最高级（local_only 优先）
    let classification = "public";
    for (const it of batch) {
      const c = it.record.event.classification ?? "personal";
      if ((CLASSIFICATION_RANK[c] ?? 1) > (CLASSIFICATION_RANK[classification] ?? 1)) {
        classification = c;
      }
    }
    candidates.push({ type, content: body, evidenceIds, classification });
  }
  return candidates;
}

/** ledger：JSONL 两阶段（pending → committed），崩溃安全。 */
export class DistillLedger {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this._pending = new Map(); // distillKey -> record
    this._committed = new Set(); // distillKey
    this._eventKeys = new Set(); // 已提交候选的来源 eventKey
    this._load();
  }

  _load() {
    if (!existsSync(this.path)) return;
    for (const line of readFileSync(this.path, "utf8").split("\n").filter(Boolean)) {
      try {
        const rec = JSON.parse(line);
        if (rec.phase === "committed") {
          this._committed.add(rec.distillKey);
          this._pending.delete(rec.distillKey);
          for (const k of rec.eventKeys ?? []) this._eventKeys.add(k);
        } else if (rec.phase === "pending") {
          this._pending.set(rec.distillKey, rec);
        }
      } catch {
        /* 半行忽略（append 崩溃残留） */
      }
    }
  }

  _append(rec) {
    appendFileSync(this.path, JSON.stringify(rec) + "\n");
  }

  /** distillKey = 来源 eventKey 集合的稳定哈希。 */
  static distillKey(eventKeys) {
    return createHash("sha256").update([...eventKeys].sort().join("|")).digest("hex").slice(0, 24);
  }

  has(distillKey) {
    return this._committed.has(distillKey) || this._pending.has(distillKey);
  }

  /** 事件是否已被任何已提交候选覆盖。 */
  coversEventKey(eventKey) {
    return this._eventKeys.has(eventKey);
  }

  begin(distillKey, eventKeys) {
    this._append({ phase: "pending", distillKey, eventKeys, at: new Date().toISOString() });
    this._pending.set(distillKey, { distillKey, eventKeys });
  }

  commit(distillKey, eventKeys, proposalId) {
    this._append({
      phase: "committed",
      distillKey,
      eventKeys,
      proposalId,
      at: new Date().toISOString(),
    });
    this._committed.add(distillKey);
    this._pending.delete(distillKey);
    for (const k of eventKeys) this._eventKeys.add(k);
  }

  stats() {
    return {
      committed: this._committed.size,
      pending: this._pending.size,
      coveredEvents: this._eventKeys.size,
      path: this.path,
    };
  }
}

/**
 * 调用本地模型抽取（纯 chat completion，无 tools 字段）。
 * @throws {DistillConfigError} 非回环端点且未显式允许
 */
export async function extractWithModel(batch, { modelBaseUrl, model, apiKey, fetchImpl = fetch, allowRemote = false, timeoutMs = 120_000 }) {
  if (!isLoopbackUrl(modelBaseUrl) && !allowRemote) {
    throw new DistillConfigError(
      `模型端点 ${modelBaseUrl} 非回环地址。按设计 §11.7 候选抽取禁止自动云端回退；` +
        `确需远端调试请加 --allow-remote（会向该端点发送用户私人内容）。`,
    );
  }
  const res = await fetchImpl(`${modelBaseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你是记忆提炼器，只输出 JSON 数组，无任何工具能力。" },
        { role: "user", content: buildExtractionPrompt(batch) },
      ],
      temperature: 0.2,
      max_tokens: 2048,
      stream: false,
      // 注意：不带 tools / tool_choice —— 提炼器无执行能力（§11.7）
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`模型端点 HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("模型响应缺少 choices[0].message.content");
  return content;
}

/**
 * 单批完整流程：抽取 → 校验 → propose → ledger。
 * @param {object} deps
 * @param {(cand: object) => Promise<{proposal_id?: string}>} deps.propose
 * @returns {{distillKey, proposals: Array, skipped?: string}}
 */
export async function distillBatch(batch, deps) {
  const { ledger, propose, extract } = deps;
  const eventKeys = batch.map((it) => it.eventKey);
  const distillKey = DistillLedger.distillKey(eventKeys);

  if (ledger && ledger.has(distillKey) && !deps.retryPending) {
    return { distillKey, proposals: [], skipped: "ledger-hit" };
  }
  if (ledger) ledger.begin(distillKey, eventKeys);

  let raw;
  try {
    raw = await extract(batch);
  } catch (err) {
    // 抽取失败：pending 记录保留（--retry-pending 可重试），但不阻塞其它批次
    return { distillKey, proposals: [], skipped: `extract-failed: ${err.message}` };
  }

  let candidates;
  try {
    candidates = parseModelOutput(raw, batch);
  } catch (err) {
    return { distillKey, proposals: [], skipped: `parse-failed: ${err.message}` };
  }
  if (candidates.length === 0) {
    // 空抽取是合法结果（宁缺毋滥）：直接提交 committed，避免反复重跑
    if (ledger) ledger.commit(distillKey, eventKeys, null);
    return { distillKey, proposals: [], skipped: "no-candidates" };
  }

  const proposals = [];
  for (const cand of candidates) {
    const res = await propose({
      type: cand.type,
      content: cand.content,
      scope: "global",
      classification: cand.classification,
      evidenceIds: cand.evidenceIds,
    });
    proposals.push({ proposalId: res?.proposal_id ?? res?.id ?? null, ...cand });
  }
  if (ledger) ledger.commit(distillKey, eventKeys, proposals.map((p) => p.proposalId).filter(Boolean));
  return { distillKey, proposals };
}
