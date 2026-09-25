/**
 * pgm-client.test.mjs — PgmClient 单元测试（mock PGM）。
 * 覆盖：就绪检查、schema 版本校验、错误映射、local_only 深度防御、basicflight。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PgmClient, PgmApiError, ProtocolError, LocalOnlyLeakError, isCloudDestination } from "../../adapter/lib/pgm-client.js";
import { createMockPgm, makeSnapshot, TEST_TOKEN } from "./helpers/mock-pgm.mjs";

function makeClient(baseUrl, overrides = {}) {
  return new PgmClient({
    baseUrl,
    token: TEST_TOKEN,
    projectId: "personal-agent",
    destination: "mtplx",
    ...overrides,
  });
}

test("ready = healthz + 一次授权请求", async () => {
  const mock = createMockPgm({
    "GET /healthz": () => ({ body: { status: "ok" } }),
    "POST /v1/search": (entry) => {
      assert.equal(entry.headers.authorization, `Bearer ${TEST_TOKEN}`);
      assert.equal(entry.body.project, "personal-agent");
      return { body: { hits: [] } };
    },
  });
  const base = await mock.listen();
  try {
    const r = await makeClient(base).ready();
    assert.equal(r.ok, true);
  } finally {
    await mock.close();
  }
});

test("buildContext 绑定实例 destination 且校验 schema 版本", async () => {
  const snap = makeSnapshot({ destination: "mtplx" });
  const mock = createMockPgm({
    "POST /v1/context:build": (entry) => {
      assert.equal(entry.body.destination, "mtplx");
      assert.equal(entry.body.project, "personal-agent");
      return { body: snap };
    },
  });
  const base = await mock.listen();
  try {
    const r = await makeClient(base).buildContext({ purpose: "测试" });
    assert.equal(r.snapshot_id, "snap_test_1");
  } finally {
    await mock.close();
  }
});

test("buildContext 拒绝不兼容协议版本", async () => {
  const snap = makeSnapshot({});
  snap.schema_version = "pgm.context.v2";
  const mock = createMockPgm({
    "POST /v1/context:build": () => ({ body: snap }),
  });
  const base = await mock.listen();
  try {
    await assert.rejects(() => makeClient(base).buildContext(), ProtocolError);
  } finally {
    await mock.close();
  }
});

test("错误映射：403 SCOPE_DENIED 带原始 code", async () => {
  const mock = createMockPgm({
    "POST /v1/search": () => ({
      status: 403,
      body: { error: { code: "SCOPE_DENIED", message: "无项目权限" } },
    }),
  });
  const base = await mock.listen();
  try {
    await assert.rejects(
      () => makeClient(base).search({ query: "x" }),
      (err) => err instanceof PgmApiError && err.code === "SCOPE_DENIED" && err.httpStatus === 403,
    );
  } finally {
    await mock.close();
  }
});

test("连接失败映射为 PGM_UNAVAILABLE(503)", async () => {
  const client = makeClient("http://127.0.0.1:1"); // 无服务端口
  await assert.rejects(
    () => client.healthz(),
    (err) => err instanceof PgmApiError && err.code === "PGM_UNAVAILABLE",
  );
});

test("local_only 深度防御：云端目的地拒绝泄漏快照", async () => {
  const leak = makeSnapshot({
    destination: "cloud:kimi",
    memories: [{ id: "mem_lo_1", version: 1, classification: "local_only", content: "私密" }],
  });
  assert.ok(isCloudDestination("cloud:kimi"));
  const mock = createMockPgm({
    "POST /v1/context:build": () => ({ body: leak }),
  });
  const base = await mock.listen();
  try {
    const client = makeClient(base, { destination: "cloud:kimi" });
    await assert.rejects(() => client.buildContext(), LocalOnlyLeakError);
  } finally {
    await mock.close();
  }
});

test("local_only 深度防御：本地目的地不拦截", async () => {
  const snap = makeSnapshot({
    destination: "mtplx",
    memories: [{ id: "mem_lo_1", version: 1, classification: "local_only", content: "私密" }],
  });
  const mock = createMockPgm({
    "POST /v1/context:build": () => ({ body: snap }),
  });
  const base = await mock.listen();
  try {
    const r = await makeClient(base).buildContext();
    assert.equal(r.memories.length, 1);
  } finally {
    await mock.close();
  }
});

test("propose 只提交候选；validate 走服务端语义", async () => {
  const mock = createMockPgm({
    "POST /v1/proposals": (entry) => {
      assert.equal(entry.body.project_id, "personal-agent");
      return { status: 201, body: { memory_id: "m1", proposal_id: "p1", proposal_hash: "h", expected_version: 1 } };
    },
    "POST /v1/context:validate": () => ({ body: { status: "stale", snapshot_id: "s1" } }),
  });
  const base = await mock.listen();
  try {
    const client = makeClient(base);
    const p = await client.propose({ type: "preference", content: "默认中文回复" });
    assert.equal(p.proposal_id, "p1");
    const v = await client.validateSnapshot("s1");
    assert.equal(v.status, "stale");
    await assert.rejects(() => client.assertSnapshotValid("s1"), (e) => e.httpStatus === 409);
  } finally {
    await mock.close();
  }
});
