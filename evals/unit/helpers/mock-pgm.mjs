/**
 * mock-pgm.mjs — 测试用最小 PGM 服务器替身。
 * 记录收到的请求（path/method/headers/body），按 handler 返回。
 */

import { createServer } from "node:http";
import { EventEmitter } from "node:events";

export function createMockPgm(handlers = {}) {
  const state = {
    requests: [], // { method, path, headers, body }
    events: new EventEmitter(),
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const entry = { method: req.method, path: req.url, headers: req.headers, body };
    state.requests.push(entry);
    state.events.emit("request", entry);

    const handler = handlers[`${req.method} ${req.url.split("?")[0]}`];
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "mock 未实现该路由" } }));
      return;
    }
    const out = await handler(entry, req);
    res.writeHead(out.status ?? 200, {
      "content-type": "application/json",
      ...(out.headers ?? {}),
    });
    res.end(out.body === undefined ? "{}" : JSON.stringify(out.body));
  });

  return {
    server,
    state,
    listen() {
      return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${server.address().port}`);
      }));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 构造合法 pgm.context.v1 快照（可注入 memories）。 */
export function makeSnapshot({ destination = "mtplx", memories = [], snapshotId = "snap_test_1" } = {}) {
  return {
    schema_version: "pgm.context.v1",
    snapshot_id: snapshotId,
    project_id: "personal-agent",
    destination,
    policy_revision: 1,
    scope_revisions: { personal: 1, "project:personal-agent": 1 },
    status: "valid",
    memory_refs: memories.map((m) => ({ id: m.id, version: m.version ?? 1 })),
    evidence_refs: [],
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    memories,
    conflicts: [],
    open_questions: [],
    excluded_summary: {},
    budget: {},
    snapshot_hash: "",
  };
}

export const TEST_TOKEN = "test-token-for-coagent";
