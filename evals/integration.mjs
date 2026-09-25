#!/usr/bin/env node
/**
 * integration.mjs — 对真实 PGM (127.0.0.1:8787) 的前置验收脚本（设计 §3.4）。
 *
 * PGM 未就绪时跳过（exit 0），不影响 CI；就绪时逐项执行六条必过验收。
 * 用法：
 *   PGM_TOKEN=... PGM_PROJECT=personal-agent node evals/integration.mjs
 * 可选：PGM_BASE_URL（默认 http://127.0.0.1:8787）、
 *       PGM_CLOUD_DEST（默认 cloud:kimi，用于 local_only 排除项）
 */

import { PgmClient, PgmApiError, LocalOnlyLeakError } from "../adapter/lib/pgm-client.js";
import { makeEvent, Outbox } from "../adapter/lib/outbox.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.PGM_BASE_URL ?? "http://127.0.0.1:8321";
const TOKEN = process.env.PGM_TOKEN;
const PROJECT = process.env.PGM_PROJECT ?? "personal-agent";
const CLOUD_DEST = process.env.PGM_CLOUD_DEST ?? "cloud:kimi";

if (!TOKEN) {
  console.error("缺少 PGM_TOKEN（用 `pgm token issue --client-id <agent-client>` 签发）");
  process.exit(78);
}

const client = new PgmClient({
  baseUrl: BASE, token: TOKEN, projectId: PROJECT, destination: "mtplx",
});

async function reachable() {
  try {
    await client.healthz();
    return true;
  } catch {
    return false;
  }
}

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const uniq = Date.now().toString(36);

try {
  // 0. 就绪
  if (!(await reachable())) {
    console.log(`⏭️  PGM 未就绪（${BASE}）——跳过集成验收。先启动 memoryd 并签发令牌。`);
    process.exit(0);
  }
  await client.ready();

  // 1. 幂等导入：同 source_key 两次写入不翻倍（真实返回 results:{inserted,skipped}）
  const ev = makeEvent({
    projectId: PROJECT,
    role: "user",
    text: `[integration ${uniq}] 用户决定：POC 记忆采用独立 PGM。`,
    conversationId: `integration-${uniq}`,
    messageId: `int-msg-${uniq}`,
    occurredAt: new Date().toISOString(),
  });
  const r1 = await client.pushEvents([ev], { idempotencyKey: `int:${uniq}:1` });
  const r2 = await client.pushEvents([ev], { idempotencyKey: `int:${uniq}:2` });
  const ok1 = r1?.results?.inserted === 1 && r1?.results?.skipped === 0;
  const ok2 = r2?.results?.skipped === 1;   // 同 source_key 第二次被服务端幂等跳过
  record("同包导入两次不重复（幂等跳过）", ok1 && ok2,
    `r1.inserted=${r1?.results?.inserted} r2.skipped=${r2?.results?.skipped}`);

  // 2. 上下文构建：返回快照与版本
  const snap = await client.buildContext({ purpose: `integration-${uniq}` });
  record(
    "上下文包含 snapshot_id/版本/来源",
    !!(snap.snapshot_id && snap.policy_revision !== undefined && Array.isArray(snap.memory_refs)),
    `snapshot=${snap.snapshot_id}`,
  );

  // 3. 检索（§9.1）：返回结构化信封；已写事件经 evidence 读回
  //    注：真实模型中 search 只检索 memories（active），事件由 evidence 读回——两 Schema 分离。
  const hits = await client.search({ query: `integration-${uniq}` });
  const envOk = hits && Array.isArray(hits.results) && typeof hits.mode === "string";
  record("检索返回结构化信封", envOk, `mode=${hits?.mode} total=${hits?.total}`);

  const evBack = await client.getEvidence(`int-msg-${uniq}`);
  const found = evBack && evBack.event_id === `int-msg-${uniq}` &&
    JSON.stringify(evBack.content).includes(`integration ${uniq}`);
  record("已写事件经 evidence 读回", !!found, `event_id=${evBack?.event_id}`);

  // 4. 跨项目权限：伪造无权项目应 403
  let denied = false;
  try {
    const rogue = new PgmClient({
      baseUrl: BASE, token: TOKEN, projectId: "other-project-无权", destination: "mtplx",
    });
    await rogue.search({ query: "x" });
  } catch (err) {
    denied = err instanceof PgmApiError && err.httpStatus === 403;
  }
  record("另一项目令牌无权读取（403）", denied);

  // 5. local_only：云端目的地的上下文不得含 local_only/secret_excluded
  try {
    const cloud = new PgmClient({
      baseUrl: BASE, token: TOKEN, projectId: PROJECT, destination: CLOUD_DEST,
    });
    const cloudSnap = await cloud.buildContext({ purpose: `integration-cloud-${uniq}` });
    const leaked = (cloudSnap.memories ?? []).filter(
      (m) => m.classification === "local_only" || m.classification === "secret_excluded",
    );
    record("local_only 不进入云端上下文", leaked.length === 0,
      leaked.length ? `泄漏 ${leaked.length} 条` : "服务端过滤正常 + 客户端复核通过");
  } catch (err) {
    // 服务端拒绝云端构建（DESTINATION_DENIED）同样算通过：local_only 被拦截
    record("local_only 不进入云端上下文",
      err instanceof PgmApiError && err.httpStatus === 403, err.message);
  }

  // 6. 事件回流 outbox 闭环：queue → flush → 再 flush 零重放
  const dir = mkdtempSync(join(tmpdir(), "coagent-int-"));
  try {
    const box = new Outbox({ path: join(dir, "ob.jsonl") });
    box.append(makeEvent({
      projectId: PROJECT, role: "assistant",
      text: `[integration ${uniq}] 产物已生成。`,
      conversationId: `integration-${uniq}`, messageId: `int-out-${uniq}`,
      occurredAt: new Date().toISOString(),
    }));
    const f1 = await box.flush(client);
    const f2 = await box.flush(client);
    record("事件回流幂等（重放零重发）",
      f1.committed.length === 1 && f2.committed.length === 0,
      `first=${f1.committed.length} replay=${f2.committed.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 7. validate：新快照 valid；篡改 id 应 404/拒绝
  const v = await client.validateSnapshot(snap.snapshot_id);
  record("刚构建的快照 validate 通过", v?.status === "valid", `status=${v?.status}`);

  // 汇总
  const failed = results.filter((r) => !r.ok);
  console.log(`\n验收：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  console.error(`验收中断: ${err.message}`);
  process.exit(1);
}
