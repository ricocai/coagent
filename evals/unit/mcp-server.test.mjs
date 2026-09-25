/**
 * mcp-server.test.mjs — MCP stdio 适配器端到端测试。
 * 启动真实子进程（newline-delimited JSON-RPC），PGM 指向 mock。
 * 覆盖：initialize、tools/list、tools/call（search / events_queue / events_flush /
 *       propose / 工具级错误上报）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockPgm, makeSnapshot, TEST_TOKEN } from "./helpers/mock-pgm.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "../../adapter/bin/pgm-adapter.mjs");

function startAdapter(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = [];
  let buf = "";
  const waiters = [];
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const w = waiters.shift();
      if (w) w(msg);
      else pending.push(msg);
    }
  });
  const next = (timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      if (pending.length) return resolve(pending.shift());
      const timer = setTimeout(() => reject(new Error("等待响应超时")), timeoutMs);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  const rpc = async (method, params, id) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return next();
  };
  return { child, rpc, next };
}

test("MCP 适配器端到端：握手 → 工具清单 → 调用闭环", async (t) => {
  const built = [];
  const proposals = [];
  const eventsSeen = [];
  const mock = createMockPgm({
    "GET /healthz": () => ({ body: { status: "ok" } }),
    "POST /v1/search": () => ({ body: { hits: [{ id: "mem_1", version: 1, status: "active" }] } }),
    "POST /v1/context:build": (e) => {
      built.push(e.body);
      return { body: makeSnapshot({ destination: "mtplx" }) };
    },
    "POST /v1/proposals": (e) => {
      proposals.push(e.body);
      return { status: 201, body: { memory_id: "m9", proposal_id: "p9", proposal_hash: "h9", expected_version: 1 } };
    },
    "POST /v1/events:batch": (e) => {
      eventsSeen.push(...e.body.events);
      return { body: { results: [], job_id: "j9" } };
    },
  });
  const base = await mock.listen();
  const outboxDir = mkdtempSync(join(tmpdir(), "coagent-mcp-"));
  t.after(async () => {
    rmSync(outboxDir, { recursive: true, force: true });
    await mock.close();
  });

  const adapter = startAdapter({
    PGM_BASE_URL: base,
    PGM_TOKEN: TEST_TOKEN,
    PGM_PROJECT: "personal-agent",
    PGM_DESTINATION: "mtplx",
    PGM_OUTBOX_PATH: join(outboxDir, "ob.jsonl"),
    PGM_SESSION: "sess-e2e",
  });
  t.after(() => adapter.child.kill());

  // 1. initialize 握手
  const init = await adapter.rpc("initialize", { protocolVersion: "2024-11-05" }, 1);
  assert.equal(init.result.protocolVersion, "2024-11-05");
  assert.equal(init.result.serverInfo.name, "personal-context");
  adapter.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 2. tools/list：7 个 memory.* 工具
  const list = await adapter.rpc("tools/list", {}, 2);
  const names = list.result.tools.map((x) => x.name);
  assert.deepEqual(names, [
    "memory.search",
    "memory.build_context",
    "memory.get_evidence",
    "memory.propose",
    "memory.events_queue",
    "memory.events_flush",
    "memory.events_status",
  ]);

  // 3. memory.search：目标路由 / 项目 / 令牌由服务端配置绑定
  const s = await adapter.rpc("tools/call", { name: "memory.search", arguments: { query: "Harness" } }, 3);
  assert.equal(s.result.isError, false);
  assert.match(s.result.content[0].text, /mem_1/);

  // 4. memory.build_context：destination 不可被调用方改写
  const b = await adapter.rpc(
    "tools/call",
    { name: "memory.build_context", arguments: { purpose: "POC", destination: "cloud:kimi" } },
    4,
  );
  assert.equal(b.result.isError, false);
  assert.equal(built[0].destination, "mtplx", "调用方指定的 destination 被忽略");
  assert.equal(built[0].project, "personal-agent");
  assert.match(b.result.content[0].text, /snapshot_id/);

  // 5. memory.propose → 候选（服务端无审批权调用）
  const p = await adapter.rpc(
    "tools/call",
    { name: "memory.propose", arguments: { type: "preference", content: "报告优先 Markdown" } },
    5,
  );
  assert.match(p.result.content[0].text, /等待用户在 PGM 管理入口确认/);
  assert.equal(proposals[0].project_id, "personal-agent");

  // 6. 事件回流闭环：queue → flush → mock 收到
  const q = await adapter.rpc(
    "tools/call",
    { name: "memory.events_queue", arguments: { role: "user", text: "决定用 PGM", message_id: "m-a" } },
    6,
  );
  assert.equal(q.result.isError, false);
  const f = await adapter.rpc("tools/call", { name: "memory.events_flush", arguments: {} }, 7);
  assert.equal(f.result.isError, false);
  await adapter.rpc("tools/call", { name: "memory.events_status", arguments: {} }, 8);
  assert.deepEqual(eventsSeen.map((e) => e.event_id), ["m-a"]);

  // 7. 工具级错误以 isError 上报（§4.4：明确报告失败，不宣称完成）
  const bad = await adapter.rpc("tools/call", { name: "memory.get_evidence", arguments: {} }, 9);
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /工具失败/);
});
