#!/usr/bin/env node
/**
 * pgm-distill — 事件 → 候选记忆 提炼 CLI（设计 §11.7 / §5.2）。
 *
 * 数据源：本地 outbox（pgm-outbox.jsonl）中已 committed 的 role=user 事件。
 * 抽取：本地模型（默认 MTPLX 127.0.0.1:8001，model mtplx-flash-next-optimized-speed），
 *       纯 chat completion、无执行工具、禁止自动云端回退。
 * 产出：POST /v1/proposals 候选（带 evidence_ids），用户在 PGM 收件箱确认。
 *
 * 用法：
 *   pgm-distill --dry-run            # 只显示将处理的事件，不调模型、不提交
 *   pgm-distill --json               # 机器可读输出
 *   pgm-distill --limit 20           # 本次最多处理 20 条事件
 *   pgm-distill --retry-pending      # 崩溃/失败后重试 pending 批次
 *   pgm-distill --status             # 只显示 ledger 统计
 *
 * 退出码：0 成功；78 缺 PGM_TOKEN；3 模型端点不可达；4 全部批次抽取失败。
 */

import { readFileSync, existsSync } from "node:fs";
import { configFromEnv, createClient, createOutbox } from "../lib/tools.js";
import {
  DistillLedger,
  DistillConfigError,
  selectEvents,
  batchEvents,
  distillBatch,
  extractWithModel,
} from "../lib/distill.js";

function arg(opts, name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  if (typeof opts === "boolean") return true;
  return process.argv[i + 1] ?? fallback;
}

const has = (name) => process.argv.includes(name);
const JSON_OUT = has("--json");
const DRY_RUN = has("--dry-run");
const STATUS_ONLY = has("--status");
const RETRY_PENDING = has("--retry-pending");
const ALLOW_REMOTE = has("--allow-remote");
const LIMIT = Number(arg(false, "--limit", "0")) || Infinity;
const BATCH_CHARS = Number(arg(false, "--batch-chars", "3000")) || 3000;
const MODEL_BASE_URL = arg(false, "--model-base-url", "http://127.0.0.1:8001");
const MODEL = arg(false, "--model", "mtplx-flash-next-optimized-speed");

function emit(obj) {
  console.log(JSON_OUT ? JSON.stringify(obj) : JSON.stringify(obj, null, 2));
}

let cfg;
try {
  cfg = configFromEnv(process.env);
} catch (err) {
  console.error(err.message);
  process.exit(78);
}

const ledger = new DistillLedger(
  process.env.PGM_DISTILL_LEDGER ?? `${cfg.outboxPath.replace(/\.jsonl$/, "")}-distill-ledger.jsonl`,
);

if (STATUS_ONLY) {
  emit({ ledger: ledger.stats(), model: { base: MODEL_BASE_URL, id: MODEL } });
  process.exit(0);
}

const outbox = createOutbox(cfg);

// 读取全部 outbox 记录（Outbox 类未暴露只读全量列表，直接读文件）
const records = existsSync(outbox.path)
  ? readFileSync(outbox.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

const selected = selectEvents(records, {
  ledgerKeys: new Set(), // 由 ledger 内部 coversEventKey 过滤，见下
  projectId: cfg.projectId,
  limit: LIMIT,
}).filter((it) => !ledger.coversEventKey(it.eventKey));

if (selected.length === 0) {
  emit({ events: 0, message: "无待提炼事件（outbox 无新 committed 用户事件，或已全部覆盖）", ledger: ledger.stats() });
  process.exit(0);
}

if (DRY_RUN) {
  emit({
    dryRun: true,
    events: selected.length,
    batches: batchEvents(selected, { maxChars: BATCH_CHARS }).length,
    model: { base: MODEL_BASE_URL, id: MODEL, loopback: /127\.0\.0\.1|localhost|::1/.test(MODEL_BASE_URL) },
    sample: selected.slice(0, 5).map((it) => ({
      eventKey: it.eventKey,
      eventId: it.record.event.event_id,
      preview: (it.record.event.content?.[0]?.text ?? "").slice(0, 60),
    })),
  });
  process.exit(0);
}

const client = createClient(cfg);
const apiKey = process.env.PGM_HARNESS_TOKEN ?? cfg.token;

let ok = 0;
let failedBatches = 0;
const allProposals = [];

const batches = batchEvents(selected, { maxChars: BATCH_CHARS });
for (const batch of batches) {
  try {
    const r = await distillBatch(batch, {
      ledger,
      retryPending: RETRY_PENDING,
      propose: (cand) => client.propose(cand),
      extract: (b) =>
        extractWithModel(b, {
          modelBaseUrl: MODEL_BASE_URL,
          model: MODEL,
          apiKey,
          allowRemote: ALLOW_REMOTE,
        }),
    });
    if (r.skipped) {
      emit({ batch: r.distillKey, skipped: r.skipped });
      if (String(r.skipped).startsWith("extract-failed") || String(r.skipped).startsWith("parse-failed")) {
        failedBatches += 1;
      }
    } else {
      ok += 1;
      allProposals.push(...r.proposals);
      emit({
        batch: r.distillKey,
        proposals: r.proposals.map((p) => ({
          proposal_id: p.proposalId,
          type: p.type,
          content: p.content,
          evidence_ids: p.evidenceIds,
          classification: p.classification,
        })),
      });
    }
  } catch (err) {
    if (err instanceof DistillConfigError) {
      console.error(err.message);
      process.exit(3);
    }
    failedBatches += 1;
    emit({ error: err.message });
  }
}

emit({
  summary: {
    batchesOk: ok,
    batchesFailed: failedBatches,
    proposals: allProposals.length,
    ledger: ledger.stats(),
  },
  note: "候选需在 PGM 收件箱确认后生效（Agent 无审批权，§5.2）",
});

process.exit(failedBatches > 0 ? 4 : 0);
