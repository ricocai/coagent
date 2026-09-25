#!/usr/bin/env node
/**
 * pgm-session-capture.mjs — dsh 会话原生采集 CLI（本轮 P0 迭代）。
 *
 * 作用：把 Harness 真实会话（用户提问 + 助手结论）自动回流到 PGM，
 *       替代「靠模型自觉调用 events:queue」的不可靠路径。
 *
 * 安全默认：
 *  - 默认不 push 真实数据？不：默认会 push，但请先用 --dry-run 看清楚；
 *  - 默认不采集工具调用/结果（实测含 API key 等敏感串）；
 *  - 默认不采集 reasoning（模型内部推理，不代表用户意图）；
 *  - 跳过注入材料（PGM 召回 / 系统提示 / 技能目录），切断回流污染循环；
 *  - 正文自动脱敏后再出网。
 *
 * 幂等：message_id = dsh:<sessionId>:<seq> + outbox eventKey 去重 +
 *      服务端 source_key 幂等 —— 重复运行不会翻倍。
 *
 * 环境变量：
 *  PGM_BASE_URL / PGM_PROJECT / PGM_OUTBOX_PATH 同适配器（见 tools.js）
 *  PGM_TOKEN：优先；缺省时回退读 PGM_HARNESS_TOKEN（系统环境变量名）
 *  PGM_ZSTD_BIN：可选，指定 zstd 可执行文件
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { configFromEnv, createClient, createOutbox } from "../lib/tools.js";
import {
  planCapture,
  resolveZstdBin,
  readSessionRecords,
} from "../lib/session-capture.js";

const HELP = `pgm-session-capture — 把 dsh 会话自动回流到 PGM

用法:
  pgm-session-capture [选项]

模式:
  --once              扫描一次并退出（默认）
  --watch [秒]        持续轮询，默认 30s 一次；Ctrl-C 退出
  --dry-run           只统计/预览，不落 outbox、不推送（无需令牌）

采集范围:
  --include-tools     一并采集 tool/call 与 tool/result（默认关闭，慎含密钥）
  --include-reasoning 一并采集助手 reasoning（默认关闭）
  --max-chars N       单条正文截断上限，默认 8000
  --limit N           最多处理 N 个最近会话

配置:
  --sessions DIR      会话目录，默认 $DSH_HOME/sessions
  --state DIR         游标存放目录，默认 ~/c-doing/c-agent/state/dsh
  --project ID        目标项目，默认取 PGM_PROJECT
  --batch-size N      每批推送事件数，默认 20
  --json              输出完整 JSON 摘要
`;

function parseArgs(argv) {
  const o = {
    once: true,
    watchSec: 0,
    dryRun: false,
    includeTools: false,
    includeReasoning: false,
    maxChars: 8000,
    limit: undefined,
    sessions: null,
    state: `${homedir()}/c-doing/c-agent/state/dsh`,
    project: null,
    batchSize: 20,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        return { help: true };
      case "--once":
        o.once = true;
        o.watchSec = 0;
        break;
      case "--watch": {
        o.once = false;
        const n = Number(argv[i + 1]);
        if (Number.isFinite(n) && n > 0) {
          o.watchSec = n;
          i += 1;
        } else {
          o.watchSec = 30;
        }
        break;
      }
      case "--dry-run":
        o.dryRun = true;
        break;
      case "--include-tools":
        o.includeTools = true;
        break;
      case "--include-reasoning":
        o.includeReasoning = true;
        break;
      case "--json":
        o.json = true;
        break;
      case "--max-chars":
        o.maxChars = Number(argv[++i]);
        break;
      case "--limit":
        o.limit = Number(argv[++i]);
        break;
      case "--sessions":
        o.sessions = argv[++i];
        break;
      case "--state":
        o.state = argv[++i];
        break;
      case "--project":
        o.project = argv[++i];
        break;
      case "--batch-size":
        o.batchSize = Number(argv[++i]);
        break;
      default:
        return { error: `未知参数: ${a}` };
    }
  }
  return o;
}

function loadCursors(path) {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function saveCursors(path, cursors) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cursors, null, 2));
  renameSync(tmp, path); // 原子替换，避免中断产生半文件
  return path;
}

async function runCycle(opts, cfg, client, outbox, zstdBin) {
  const cursorsPath = join(opts.state, "capture-cursors.json");
  const cursors = opts.dryRun ? {} : loadCursors(cursorsPath);

  const plan = planCapture({
    sessionsDir: opts.sessions,
    projectId: opts.project ?? cfg.projectId,
    cursors,
    includeTools: opts.includeTools,
    includeReasoning: opts.includeReasoning,
    maxChars: opts.maxChars,
    limit: opts.limit,
    readImpl: readSessionRecords,
    zstdBin,
  });

  let queued = 0;
  let deduped = 0;
  let failed = 0;
  let lastError = null;

  if (!opts.dryRun) {
    for (const ev of plan.events) {
      try {
        const r = outbox.append(ev);
        if (r.queued) queued += 1;
        else deduped += 1;
      } catch (err) {
        failed += 1;
        lastError = err.message;
      }
    }
  }

  let sent = null;
  if (!opts.dryRun && queued > 0) {
    sent = await outbox.flush(client, { batchSize: opts.batchSize });
  }

  if (!opts.dryRun) saveCursors(cursorsPath, plan.cursors);

  return { plan, queued, deduped, failed, sent, lastError, cursorsPath };
}

function printSummary(r, opts) {
  const s = r.plan.stats;
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          stats: s,
          queued: r.queued,
          deduped: r.deduped,
          failed: r.failed,
          sent: r.sent,
          lastError: r.lastError,
          events: opts.json && process.env.PGM_CAPTURE_DUMP === "1" ? r.plan.events : undefined,
        },
        null,
        2,
      ),
    );
    return;
  }
  const head = opts.dryRun ? "[dry-run] " : "";
  console.log(
    `${head}会话 ${s.sessionsScanned}/${s.sessionsTotal} 扫描 · 记录 ${s.recordsRead}（坏行 ${s.malformed}）· 候选 ${s.candidates}`,
  );
  console.log(
    `${head}生成事件 ${s.events} · 跳过注入 ${s.skippedInjected} · 脱敏 ${s.redacted} · 截断 ${s.truncated} · 空 ${s.empty}`,
  );
  if (opts.dryRun) {
    console.log("[dry-run] 未写入 outbox，未推送 PGM");
    return;
  }
  console.log(`入队 ${r.queued} · outbox 去重跳过 ${r.deduped} · 入队失败 ${r.failed}`);
  if (r.sent) console.log(`推送：committed=${r.sent.committed.length} failed=${r.sent.failed}`);
  if (r.lastError) console.log(`错误：${r.lastError}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${HELP}`);
    return 2;
  }
  const opts = parsed;

  const zstd = resolveZstdBin();
  if (!zstd.ok) {
    process.stderr.write(
      `未找到可用的 zstd：会话文件是多帧 zstd，Node 原生 zlib 无法完整读取。\n` +
        `已尝试: ${zstd.tried.join(", ")}\n` +
        `请安装后重试，或用 PGM_ZSTD_BIN 指定路径（brew install zstd）。\n`,
    );
    return 79;
  }

  if (!opts.sessions) {
    const dshHome = process.env.DSH_HOME ?? `${homedir()}/c-doing/c-agent/state/dsh`;
    opts.sessions = join(dshHome, "sessions");
  }

  let cfg;
  let client = null;
  let outbox = null;
  if (!opts.dryRun) {
    // 令牌兼容：dsh 侧注入 PGM_TOKEN；手工在终端跑时系统里是 PGM_HARNESS_TOKEN。
    if (!process.env.PGM_TOKEN && process.env.PGM_HARNESS_TOKEN) {
      process.env.PGM_TOKEN = process.env.PGM_HARNESS_TOKEN;
    }
    try {
      cfg = configFromEnv();
    } catch (err) {
      process.stderr.write(`配置错误: ${err.message}\n`);
      return 78;
    }
    client = createClient(cfg);
    outbox = createOutbox(cfg);
  } else {
    cfg = { projectId: process.env.PGM_PROJECT ?? "personal-agent" };
  }

  const style = opts.dryRun ? "dry-run" : "采集";
  if (opts.watchSec > 0) {
    console.log(`开始轮询${style}：每 ${opts.watchSec}s 扫描 ${opts.sessions}`);
  }

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
  });

  do {
    const r = await runCycle(opts, cfg, client, outbox, zstd.bin);
    printSummary(r, opts);
    if (opts.watchSec > 0 && !stop) {
      await new Promise((res) => setTimeout(res, opts.watchSec * 1000));
    }
  } while (opts.watchSec > 0 && !stop);

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`采集失败: ${err?.message ?? err}\n`);
    process.exit(1);
  });
