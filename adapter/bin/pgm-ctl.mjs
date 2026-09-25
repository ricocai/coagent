#!/usr/bin/env node
/**
 * pgm-ctl.mjs — PGM 受限 CLI（MCP server 的同逻辑命令行版）。
 *
 * 用途：Harness 尚未接 MCP 时，Agent 可通过 shell 工具直接调用本 CLI
 * 完成记忆读取/候选提交/回流；也是联调与验收的排障入口。
 *
 * 退出码：0 成功；2 PGM 不可用；3 凭据/权限；4 快照失效；5 其他 PGM 错误；
 *         6 协议不兼容；7 local_only 泄漏；1 参数/未知错误。
 */

import {
  configFromEnv,
  createClient,
  createOutbox,
  dispatchTool,
  queueEventsFromJsonl,
  exitCodeFor,
} from "../lib/tools.js";

function usage() {
  console.log(`用法: pgm-ctl <子命令> [参数]

子命令:
  health                                  存活检查（无鉴权）
  ready                                   就绪检查（存活 + 授权请求）
  search <query> [--limit N]              项目内检索
  build [--purpose S] [--query S]         构建上下文包（输出 snapshot_id 等）
        [--budget N] [--ttl N] [--out FILE]
  validate <snapshot_id>                  校验快照（singleflight，completed 不缓存）
  evidence <event_id>                     读取获准证据片段
  propose --type T --content S            提交记忆候选（无审批权）
        [--scope S] [--classification C] [--evidence ID,ID]
  events:queue --file FILE.jsonl          从 JSONL 批量入队回流事件
  events:flush [--batch N]                重放 outbox pending 事件（幂等）
  events:status                           PGM 就绪 + outbox 积压状态

环境变量:
  PGM_BASE_URL   默认 http://127.0.0.1:8787
  PGM_TOKEN      必填（pgm token issue 签发；勿写入代码/日志）
  PGM_PROJECT    默认 personal-agent
  PGM_DESTINATION 默认 local；云端目的地（cloud:*）会做 local_only 深度复核`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    process.exit(cmd ? 0 : 1);
  }
  const { positional, flags } = parseArgs(rest);

  let client;
  let outbox;
  try {
    const cfg = configFromEnv();
    client = createClient(cfg);
    outbox = createOutbox(cfg);
  } catch (err) {
    console.error(`配置错误: ${err.message}`);
    process.exit(78);
  }

  try {
    let result;
    switch (cmd) {
      case "health":
        result = await client.healthz();
        break;
      case "ready":
        result = await client.ready();
        break;
      case "search":
        if (!positional[0]) throw new Error("缺少检索词");
        result = await client.search({ query: positional[0], limit: Number(flags.limit ?? 20) });
        break;
      case "build": {
        const snap = await client.buildContext({
          purpose: flags.purpose,
          query: flags.query,
          budgetMaxTokens: Number(flags.budget ?? 4000),
          ttlMinutes: Number(flags.ttl ?? 15),
        });
        result = snap;
        if (flags.out) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(flags.out, JSON.stringify(snap, null, 2) + "\n");
          console.error(`快照已写入 ${flags.out}`);
        }
        break;
      }
      case "validate":
        if (!positional[0]) throw new Error("缺少 snapshot_id");
        result = await client.validateSnapshot(positional[0]);
        break;
      case "evidence":
        if (!positional[0]) throw new Error("缺少 event_id");
        result = await client.getEvidence(positional[0]);
        break;
      case "propose":
        result = await dispatchTool(client, outbox, "memory.propose", {
          type: flags.type,
          content: flags.content,
          scope: flags.scope,
          classification: flags.classification,
          evidence_ids: flags.evidence ? String(flags.evidence).split(",") : [],
        });
        break;
      case "events:queue":
        if (!flags.file) throw new Error("缺少 --file");
        result = queueEventsFromJsonl(outbox, flags.file);
        break;
      case "events:flush":
        result = await dispatchTool(client, outbox, "memory.events_flush", {
          batch_size: Number(flags.batch ?? 20),
        });
        break;
      case "events:status":
        result = await dispatchTool(client, outbox, "memory.events_status", {});
        break;
      default:
        usage();
        process.exit(1);
    }
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`错误: ${err.message}`);
    process.exit(exitCodeFor(err));
  }
}

main();
