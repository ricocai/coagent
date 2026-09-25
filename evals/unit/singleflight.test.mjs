/**
 * singleflight.test.mjs — validate 去重边界（§8.1.1）。
 *
 * 规则：
 *  - 并发同 key（session|snapshot|destination|purpose）只读分支共用一次请求；
 *  - 已完成的 valid 结果不缓存：相同 key 先后两次调用 = 两次 HTTP；
 *  - key 不同（purpose 不同）不合并。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PgmClient } from "../../adapter/lib/pgm-client.js";
import { createMockPgm, TEST_TOKEN } from "./helpers/mock-pgm.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("并发同 key 校验合并为一次 HTTP；完成后不缓存（再调一次=两次）", async () => {
  let validateCount = 0;
  const mock = createMockPgm({
    "POST /v1/context:validate": async () => {
      validateCount += 1;
      await delay(50); // 拉长在途窗口，制造并发
      return { body: { status: "valid", snapshot_id: "s1" } };
    },
  });
  const base = await mock.listen();
  try {
    const client = new PgmClient({
      baseUrl: base, token: TEST_TOKEN, projectId: "personal-agent",
      destination: "mtplx", sessionId: "sess-1",
    });
    const [a, b, c] = await Promise.all([
      client.validateSnapshot("s1"),
      client.validateSnapshot("s1"),
      client.validateSnapshot("s1"),
    ]);
    assert.equal(validateCount, 1, "三个并发同 key 应共用一次请求");
    assert.equal(a.status, "valid");
    assert.equal(b.status, "valid");
    assert.equal(c.status, "valid");

    await client.validateSnapshot("s1"); // 新调用：前一请求已完成，必须重发
    assert.equal(validateCount, 2, "completed_validation_cache_ttl_ms=0：完成即失效");
  } finally {
    await mock.close();
  }
});

test("purpose 不同不合并；失败后 in-flight 清理可重试", async () => {
  let n = 0;
  const mock = createMockPgm({
    "POST /v1/context:validate": async () => {
      const id = ++n; // delay 前取号，避免竞态下两个请求都读到最终 n
      await delay(30);
      if (id === 1) return { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } };
      return { body: { status: "valid", snapshot_id: "s1" } };
    },
  });
  const base = await mock.listen();
  try {
    const client = new PgmClient({
      baseUrl: base, token: TEST_TOKEN, projectId: "personal-agent",
      destination: "mtplx", sessionId: "sess-1",
    });
    // purpose 不同 → 两个独立请求并发（恰好一个撞上 500）
    const results = await Promise.allSettled([
      client.validateSnapshot("s1", { purpose: "plan" }),
      client.validateSnapshot("s1", { purpose: "review" }),
    ]);
    assert.equal(n, 2, "purpose 不同不合并");
    const rejectedCount = results.filter((r) => r.status === "rejected").length;
    assert.equal(rejectedCount, 1);

    // 失败请求结束后 in-flight 已清理：重试两个 purpose 都能成功
    const retry = await Promise.all([
      client.validateSnapshot("s1", { purpose: "plan" }),
      client.validateSnapshot("s1", { purpose: "review" }),
    ]);
    assert.equal(n, 4);
    assert.ok(retry.every((r) => r.status === "valid"));
  } finally {
    await mock.close();
  }
});
