/**
 * session-capture.js — dsh 会话原生采集（记忆库数据质量的关键入口）。
 *
 * 为什么必须做（ADR-0001 已知缺口 → 本轮补齐）：
 *  依靠模型/SOP 显式调用 events:queue 会漏记；而 dsh 已把完整会话追加写入
 *  $DSH_HOME/sessions/<编码cwd>/session-<uuid>/session.v3.jsonl.zstd，
 *  因此可以在不改任何 dsh 内部接口的前提下做「原生采集」。
 *
 * 边界与安全（§8.2 防回流污染 / §11 分类与脱敏）：
 *  1. 只采集 source.kind === "user" 的用户消息 —— PGM 召回注入是
 *     source.kind:"plugin"/form:"recall"，系统提示快照与技能目录同理，
 *     一律跳过。这是「记忆→注入→再采集→再注入」死循环的根治手段，
 *     比按文本特征匹配可靠得多（结构判定 > 文本猜测）。
 *  2. 助手消息默认只取最终文本，不含 reasoning（内部推理，非用户意图）。
 *  3. 工具调用/结果默认不采集：实测其中会含 API key 等敏感串。
 *  4. 即使采集正文也做脱敏（密钥/令牌/私钥），作为最后一道防线。
 *
 * 幂等：message_id = `dsh:<sessionId>:<seq>`，与服务端 source_key 同构，
 *      重扫同一会话不会产生重复事件（outbox 亦按 eventKey 去重）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { makeEvent } from "./outbox.js";

/** dsh 会话文件名（v3 格式，zstd 压缩的 JSONL）。 */
export const SESSION_FILE = "session.v3.jsonl.zstd";

/** 会话文件是多帧 zstd 拼接；Node 22 原生 zlib 读到首帧即报 Unknown frame descriptor，
 *  因此依赖外部 zstd CLI。按此顺序探测。 */
const ZSTD_CANDIDATES = [
  process.env.PGM_ZSTD_BIN,
  "zstd",
  "/opt/homebrew/bin/zstd",
  "/opt/miniconda3/bin/zstd",
  "/usr/bin/zstd",
].filter(Boolean);

/**
 * 解析可用的 zstd 可执行文件。
 * @returns {{bin: string, ok: true} | {bin: null, ok: false, tried: string[]}}
 */
export function resolveZstdBin() {
  for (const bin of ZSTD_CANDIDATES) {
    try {
      execFileSync(bin, ["-V"], { stdio: "ignore", timeout: 5000 });
      return { bin, ok: true };
    } catch {
      // 继续探测下一个候选
    }
  }
  return { bin: null, ok: false, tried: ZSTD_CANDIDATES };
}

/**
 * 解压并解析会话文件（容忍写入过程中的尾行截断）。
 * @param {string} file session.v3.jsonl.zstd 路径
 * @param {{zstdBin: string, maxBuffer?: number}} opts
 * @returns {{records: object[], header: object|null, malformed: number}}
 */
export function readSessionRecords(file, { zstdBin, maxBuffer = 256 * 1024 * 1024 }) {
  const out = execFileSync(zstdBin, ["-d", "-c", file], {
    encoding: "utf8",
    maxBuffer,
    timeout: 60_000,
  });
  const records = [];
  let malformed = 0;
  let header = null;
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      malformed += 1;
      continue;
    }
    if (rec?.type === "session" && !header) header = rec;
    records.push(rec);
  }
  return { records, header, malformed };
}

/** PGM 召回注入的文本标记（防御深度：结构判定之外的二次把关）。 */
const INJECTED_MARKERS = [
  /^\s*\[PGM 个人全局记忆/,
  /^\s*\[PGM personal global memory/i,
];

function looksInjected(text) {
  return INJECTED_MARKERS.some((re) => re.test(text));
}

// ------------------------------------------------------------------ 文本抽取

function textOfContent(parts, opts = {}) {
  if (!Array.isArray(parts)) return "";
  const allowReasoning = opts.allowReasoning === true;
  const chunks = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") chunks.push(p.text);
    else if (p.type === "reasoning" && allowReasoning && typeof p.text === "string") {
      chunks.push(p.text);
    } else if (p.type === "tool-result" && Array.isArray(p.content)) {
      chunks.push(textOfContent(p.content, opts));
    }
  }
  return chunks.join("\n").trim();
}

/**
 * 从一条会话记录抽取可回流消息；不可采集返回 null。
 * @param {object} rec 会话 JSONL 的一行
 * @param {{includeTools?: boolean, includeReasoning?: boolean}} opts
 * @returns {{role: string, text: string, seq: number, time: number|null, source: string} | null}
 */
export function extractMessage(rec, { includeTools = false, includeReasoning = false } = {}) {
  if (!rec || typeof rec !== "object") return null;
  const seq = Number(rec.seq);
  if (!Number.isFinite(seq)) return null;
  const time = Number.isFinite(Number(rec.time)) ? Number(rec.time) : null;
  const data = rec.data ?? {};

  switch (rec.type) {
    case "user/message": {
      // 结构判定：只有真人输入才回流。plugin recall / system-prompt 快照 /
      // skill-catalog 都属于注入材料，一律跳过（§8.2 防回流污染）。
      if (data?.source?.kind !== "user") return null;
      const text = textOfContent(data.content);
      if (!text || looksInjected(text)) return null;
      return { role: "user", text, seq, time, source: "user/message" };
    }
    case "assistant/message": {
      const text = textOfContent(data?.message?.content, { allowReasoning: includeReasoning });
      if (!text) return null;
      return { role: "assistant", text, seq, time, source: "assistant/message" };
    }
    case "tool/call": {
      if (!includeTools) return null;
      const name = data?.name ?? "tool";
      const args = typeof data?.arguments === "string" ? data.arguments : JSON.stringify(data?.arguments ?? "");
      const text = `[tool/call] ${name} ${args}`.trim();
      return { role: "tool", text, seq, time, source: "tool/call" };
    }
    case "tool/result": {
      if (!includeTools) return null;
      const inner = textOfContent(data?.message?.content);
      const err = data?.error ? ` error=${JSON.stringify(data.error)}` : "";
      const text = `[tool/result] ${inner || "(无文本内容)"}${err}`.trim();
      return { role: "tool", text, seq, time, source: "tool/result" };
    }
    default:
      // turn/step/permission/approval/title-usage 等控制面记录不回流
      return null;
  }
}

// ------------------------------------------------------------------ 脱敏

/** 敏感信息正则（顺序敏感：先具体后宽泛）。 */
const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/pgm-[A-Za-z0-9_\-]{16,}/g, "[REDACTED_PGM_TOKEN]"],
  [/(Bearer)\s+[A-Za-z0-9._\-]{12,}/gi, "$1 [REDACTED]"],
  [
    /\b(api[_\-]?key|apikey|access[_\-]?key|secret|password|passwd|token)\b(\s*[:=]\s*)(["']?)([A-Za-z0-9._\-]{8,})\3/gi,
    "$1$2$3[REDACTED]$3",
  ],
  [/\bsk-[A-Za-z0-9._\-]{16,}/g, "[REDACTED_KEY]"],
  [/\bghp_[A-Za-z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]"],
];

/**
 * 脱敏：即使默认不采集工具（其中多见密钥），正文仍可能是用户粘贴的凭证。
 * @param {string} text
 * @returns {{text: string, redacted: boolean}}
 */
export function redact(text) {
  let out = text;
  let redacted = false;
  for (const [re, to] of REDACTIONS) {
    const next = out.replace(re, to);
    if (next !== out) redacted = true;
    out = next;
  }
  return { text: out, redacted };
}

// ------------------------------------------------------------------ 事件构造

/**
 * 把抽取出的消息转成 pgm.event.v1（经 makeEvent，保证 schema 幂等键一致）。
 * @param {object} p
 * @param {string} p.sessionId
 * @param {string} p.projectId
 * @param {object} p.msg extractMessage 的返回值
 * @param {number} [p.maxChars] 正文截断上限
 * @param {string} [p.classification]
 */
export function buildCaptureEvent({
  sessionId,
  projectId,
  msg,
  maxChars = 8000,
  classification = "personal",
  connector = "dsh-harness",
  accountRef = "local",
}) {
  const { text: cleanText } = redact(msg.text);
  // 先 trim 再判空：否则纯空白正文会绕过 makeEvent 的空检查，
  // 变成没有信息量的垃圾事件写进记忆库（真实会话里确实存在这种消息）。
  const trimmed = typeof cleanText === "string" ? cleanText.trim() : "";
  let text = trimmed;
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars) + ` …[截断 ${trimmed.length - maxChars} 字符]`;
    truncated = true;
  }
  const messageId = `dsh:${sessionId}:${msg.seq}`;
  const occurredAt = msg.time ? new Date(msg.time).toISOString() : undefined;
  const event = makeEvent({
    projectId,
    role: msg.role,
    text,
    conversationId: sessionId,
    messageId,
    connector,
    accountRef,
    classification,
    occurredAt,
  });
  return { event, truncated, redacted: text !== msg.text };
}

// ------------------------------------------------------------------ 目录扫描

/**
 * 列出所有会话目录。
 * @param {string} sessionsDir $DSH_HOME/sessions
 * @returns {{sessionId: string, dir: string, file: string, mtimeMs: number}[]}
 */
export function listSessions(sessionsDir) {
  const found = [];
  if (!existsSync(sessionsDir)) return found;
  for (const cwdDir of readdirSync(sessionsDir)) {
    const cwdPath = join(sessionsDir, cwdDir);
    if (!statSync(cwdPath).isDirectory()) continue;
    for (const entry of readdirSync(cwdPath)) {
      const dir = join(cwdPath, entry);
      if (!statSync(dir).isDirectory() || !entry.startsWith("session-")) continue;
      const file = join(dir, SESSION_FILE);
      if (!existsSync(file)) continue;
      const mtimeMs = statSync(file).mtimeMs;
      found.push({ sessionId: basename(dir), dir, file, mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 规划一次采集（纯函数，便于单测）：扫描会话 → 抽取 → 构造事件。
 *
 * @param {object} p
 * @param {string} p.sessionsDir
 * @param {string} p.projectId
 * @param {object} [p.cursors] { [sessionId]: lastSeq }
 * @param {boolean} [p.includeTools]
 * @param {boolean} [p.includeReasoning]
 * @param {number} [p.maxChars]
 * @param {string} [p.classification]
 * @param {number} [p.limit] 最多处理多少个会话
 * @returns {{events: object[], cursors: object, stats: object}}
 */
export function planCapture({
  sessionsDir,
  projectId,
  cursors = {},
  includeTools = false,
  includeReasoning = false,
  maxChars = 8000,
  classification = "personal",
  limit,
  readImpl = readSessionRecords,
  zstdBin = null,
}) {
  const sessions = listSessions(sessionsDir);
  const picked = typeof limit === "number" ? sessions.slice(0, limit) : sessions;
  const events = [];
  const nextCursors = { ...cursors };
  const stats = {
    sessionsTotal: sessions.length,
    sessionsScanned: picked.length,
    recordsRead: 0,
    malformed: 0,
    candidates: 0,
    skippedInjected: 0,
    empty: 0,
    redacted: 0,
    truncated: 0,
    events: 0,
    perSession: [],
  };

  for (const s of picked) {
    const before = events.length;
    let read;
    try {
      read = readImpl(s.file, { zstdBin });
    } catch (err) {
      stats.perSession.push({ sessionId: s.sessionId, error: String(err?.message ?? err) });
      continue;
    }
    const cursor = Number(nextCursors[s.sessionId] ?? 0);
    let maxSeq = cursor;
    let injectedSeen = 0;
    stats.recordsRead += read.records.length;
    stats.malformed += read.malformed;

    for (const rec of read.records) {
      const seq = Number(rec.seq);
      if (Number.isFinite(seq)) {
        maxSeq = Math.max(maxSeq, seq);
        if (cursor && seq <= cursor) continue; // 断点续采：跳过已采
      }
      if (rec?.type === "user/message" && rec?.data?.source?.kind !== "user") injectedSeen += 1;
      const msg = extractMessage(rec, { includeTools, includeReasoning });
      if (!msg) continue;
      stats.candidates += 1;
      let out;
      try {
        out = buildCaptureEvent({
          sessionId: s.sessionId,
          projectId,
          msg,
          maxChars,
          classification,
        });
      } catch {
        stats.empty += 1; // makeEvent 拒绝空正文
        continue;
      }
      if (out.redacted) stats.redacted += 1;
      if (out.truncated) stats.truncated += 1;
      events.push(out.event);
    }

    if (maxSeq > cursor) nextCursors[s.sessionId] = maxSeq;
    stats.skippedInjected += injectedSeen;
    stats.perSession.push({
      sessionId: s.sessionId,
      events: events.length - before,
      injectedSkipped: injectedSeen,
    });
  }

  stats.events = events.length;
  return { events, cursors: nextCursors, stats };
}
