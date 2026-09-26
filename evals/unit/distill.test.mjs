/**
 * distill.test.mjs — 提炼管线单元测试。
 * 覆盖：回环守卫、无 tools 字段、schema 校验、脱敏、敏感度继承、
 *       ledger 两阶段幂等、evidence 映射、失败恢复。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isLoopbackUrl,
  DistillConfigError,
  DistillLedger,
  selectEvents,
  batchEvents,
  buildExtractionPrompt,
  parseModelOutput,
  extractWithModel,
  distillBatch,
} from "../../adapter/lib/distill.js";
import { makeEvent } from "../../adapter/lib/outbox.js";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "distill-test-"));
}

function userEvent(n, text, { classification = "personal", projectId = "personal-agent" } = {}) {
  const id = `dsh:session-t:seq-${n}`;
  return makeEvent({
    projectId,
    role: "user",
    text,
    conversationId: "session-t",
    messageId: id,
    classification,
    occurredAt: "2026-09-26T01:00:00Z",
  });
}

function fixtureRecords(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    eventKey: `dsh-harness|local|session-t|dsh:session-t:seq-${i}|1`,
    status: "committed",
    attempts: 1,
    lastError: null,
    event: userEvent(i, `用户决定：采用方案 ${i}。`),
    createdAt: "2026-09-26T01:00:00Z",
    committedAt: "2026-09-26T01:00:01Z",
  }));
}

describe("isLoopbackUrl", () => {
  test("回环地址返回 true", () => {
    assert.equal(isLoopbackUrl("http://127.0.0.1:8001"), true);
    assert.equal(isLoopbackUrl("http://localhost:8080"), true);
    assert.equal(isLoopbackUrl("http://[::1]:8001"), true);
  });
  test("非回环返回 false", () => {
    assert.equal(isLoopbackUrl("https://api.moonshot.cn"), false);
    assert.equal(isLoopbackUrl("http://192.168.1.5:8001"), false);
    assert.equal(isLoopbackUrl("not a url"), false);
  });
});

describe("extractWithModel 守卫与请求体", () => {
  const batch = fixtureRecords(1).map((r) => ({ record: r, eventKey: r.eventKey }));

  test("非回环端点默认拒绝（§11.7 禁自动云端回退）", async () => {
    await assert.rejects(
      () =>
        extractWithModel(batch, {
          modelBaseUrl: "https://api.moonshot.cn",
          model: "kimi",
          fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
        }),
      DistillConfigError,
    );
  });

  test("allowRemote 显式越过时可用，且请求体不含 tools 字段", async () => {
    let captured;
    const stub = async (url, init) => {
      captured = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: "[]" } }] }) };
    };
    const out = await extractWithModel(batch, {
      modelBaseUrl: "https://api.example.com",
      model: "test-model",
      apiKey: "sk-test",
      allowRemote: true,
      fetchImpl: stub,
    });
    assert.equal(out, "[]");
    assert.equal(captured.url, "https://api.example.com/v1/chat/completions");
    assert.equal(captured.body.model, "test-model");
    assert.equal("tools" in captured.body, false, "提炼器不得携带执行工具");
    assert.equal("tool_choice" in captured.body, false);
    assert.match(captured.body.messages[1].content, /记忆提炼器/);
  });

  test("回环端点无需 allowRemote", async () => {
    const out = await extractWithModel(batch, {
      modelBaseUrl: "http://127.0.0.1:8001",
      model: "m",
      fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "[]" } }] }) }),
    });
    assert.equal(out, "[]");
  });
});

describe("parseModelOutput", () => {
  const records = fixtureRecords(3);
  const batch = records.map((r) => ({ record: r, eventKey: r.eventKey }));

  test("合法输出 → 候选且 evidence 映射到 event_id", () => {
    const raw = JSON.stringify([
      { type: "decision", content: "用户决定采用方案 0。", evidence: [0] },
      { type: "todo", content: "跟进方案 2 的验收。", evidence: [2] },
    ]);
    const cands = parseModelOutput(raw, batch);
    assert.equal(cands.length, 2);
    assert.equal(cands[0].type, "decision");
    assert.deepEqual(cands[0].evidenceIds, ["dsh:session-t:seq-0"]);
    assert.equal(cands[1].classification, "personal");
  });

  test("代码围栏容错", () => {
    const raw = '```json\n[{"type":"fact","content":"事实","evidence":[1]}]\n```';
    const cands = parseModelOutput(raw, batch);
    assert.equal(cands.length, 1);
    assert.deepEqual(cands[0].evidenceIds, ["dsh:session-t:seq-1"]);
  });

  test("非法 type / 超长 content / 缺 content 被丢弃", () => {
    const raw = JSON.stringify([
      { type: "banana", content: "x", evidence: [0] },
      { type: "fact", content: "长".repeat(501), evidence: [0] },
      { type: "fact", evidence: [0] },
      { type: "fact", content: "正常", evidence: [0] },
    ]);
    const cands = parseModelOutput(raw, batch);
    assert.equal(cands.length, 1);
  });

  test("content 中的密钥被二次脱敏（纵深防御）", () => {
    const raw = JSON.stringify([
      { type: "fact", content: "用户令牌是 pgm-EXAMPLEFAKETOKEN1234567890abcdef", evidence: [0] },
    ]);
    const cands = parseModelOutput(raw, batch);
    assert.equal(cands.length, 1);
    assert.doesNotMatch(cands[0].content, /pgm-YOx/);
  });

  test("local_only 来源继承最高敏感度", () => {
    const recs = [
      { eventKey: "k0", status: "committed", event: userEvent(0, "内部决策 X。", { classification: "local_only" }) },
    ];
    const b = recs.map((r) => ({ record: r, eventKey: r.eventKey }));
    const cands = parseModelOutput('[{"type":"fact","content":"内部决策 X。","evidence":[0]}]', b);
    assert.equal(cands[0].classification, "local_only");
  });

  test("完全不可解析 → 抛错", () => {
    assert.throws(() => parseModelOutput("我觉得没什么可提炼的", batch));
  });

  test("空数组是合法输出", () => {
    assert.deepEqual(parseModelOutput("[]", batch), []);
  });
});

describe("selectEvents / batchEvents", () => {
  test("只取 committed+user+指定项目，跳过 injected 与 ledger 命中", () => {
    const records = fixtureRecords(4);
    records[1].event.origin = "injected_context";
    records[2].status = "pending";
    records[3].event.role = "assistant";
    const ledgerKeys = new Set([records[0].eventKey]);
    const out = selectEvents(records, { ledgerKeys, projectId: "personal-agent" });
    assert.equal(out.length, 0);
  });

  test("limit 生效", () => {
    const out = selectEvents(fixtureRecords(5), { ledgerKeys: new Set(), limit: 2 });
    assert.equal(out.length, 2);
  });

  test("按字符数分批", () => {
    const records = fixtureRecords(5).map((r) => ({
      ...r,
      event: userEvent(Number(r.event.event_id.slice(-1)), "字".repeat(1500)),
    }));
    const items = records.map((r) => ({ record: r, eventKey: r.eventKey }));
    const batches = batchEvents(items, { maxChars: 3000 });
    assert.equal(batches.length, 3);
    assert.equal(batches[0].length, 2);
  });
});

describe("DistillLedger 两阶段幂等", () => {
  test("pending 不算完成、commit 后命中、重载后状态保持", () => {
    const dir = tmpDir();
    try {
      const path = join(dir, "ledger.jsonl");
      const keys = ["k1", "k2"];
      const dk = DistillLedger.distillKey(keys);
      const l1 = new DistillLedger(path);
      assert.equal(l1.has(dk), false);
      l1.begin(dk, keys);
      assert.equal(l1.has(dk), true);
      // 重载：pending 仍在
      const l2 = new DistillLedger(path);
      assert.equal(l2.has(dk), true);
      assert.equal(l2.stats().pending, 1);
      l2.commit(dk, keys, ["p1"]);
      // 重载：committed 覆盖 pending，coversEventKey 生效
      const l3 = new DistillLedger(path);
      assert.equal(l3.stats().pending, 0);
      assert.equal(l3.stats().committed, 1);
      assert.equal(l3.coversEventKey("k1"), true);
      assert.equal(l3.coversEventKey("k9"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("distillBatch 端到端（桩 propose/extract）", () => {
  function setup() {
    const dir = tmpDir();
    const ledger = new DistillLedger(join(dir, "ledger.jsonl"));
    const proposed = [];
    return {
      dir,
      ledger,
      proposed,
      propose: async (cand) => {
        proposed.push(cand);
        return { proposal_id: `prop-${proposed.length}` };
      },
    };
  }

  test("正常路径：抽取 → propose → committed", async () => {
    const s = setup();
    const records = fixtureRecords(2);
    const batch = records.map((r) => ({ record: r, eventKey: r.eventKey }));
    try {
      const r = await distillBatch(batch, {
        ledger: s.ledger,
        propose: s.propose,
        extract: async () =>
          JSON.stringify([{ type: "decision", content: "用户决定采用方案。", evidence: [0, 1] }]),
      });
      assert.equal(s.proposed.length, 1);
      assert.deepEqual(s.proposed[0].evidenceIds, ["dsh:session-t:seq-0", "dsh:session-t:seq-1"]);
      assert.equal(r.proposals[0].proposalId, "prop-1");
      assert.equal(r.skipped, undefined);
      // 重跑：ledger 命中，不再 propose
      const r2 = await distillBatch(batch, { ledger: s.ledger, propose: s.propose, extract: async () => "[]" });
      assert.equal(r2.skipped, "ledger-hit");
      assert.equal(s.proposed.length, 1);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("抽取失败 → pending 保留；retryPending 重试成功", async () => {
    const s = setup();
    const records = fixtureRecords(1);
    const batch = records.map((r) => ({ record: r, eventKey: r.eventKey }));
    let calls = 0;
    const extract = async () => {
      calls += 1;
      if (calls === 1) throw new Error("MTPLX 不可达");
      return JSON.stringify([{ type: "fact", content: "恢复后提取。", evidence: [0] }]);
    };
    try {
      const r1 = await distillBatch(batch, { ledger: s.ledger, propose: s.propose, extract });
      assert.match(r1.skipped, /^extract-failed/);
      assert.equal(s.proposed.length, 0);
      // 默认重跑仍跳过（pending 防重复提交）
      const r2 = await distillBatch(batch, { ledger: s.ledger, propose: s.propose, extract });
      assert.equal(r2.skipped, "ledger-hit");
      // --retry-pending 越过并成功
      const r3 = await distillBatch(batch, { ledger: s.ledger, propose: s.propose, extract, retryPending: true });
      assert.equal(r3.skipped, undefined);
      assert.equal(s.proposed.length, 1);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("空抽取是合法结果，直接 committed 不再重跑", async () => {
    const s = setup();
    const records = fixtureRecords(1);
    const batch = records.map((r) => ({ record: r, eventKey: r.eventKey }));
    try {
      let calls = 0;
      const r = await distillBatch(batch, {
        ledger: s.ledger,
        propose: s.propose,
        extract: async () => {
          calls += 1;
          return "[]";
        },
      });
      assert.equal(r.skipped, "no-candidates");
      assert.equal(s.proposed.length, 0);
      await distillBatch(batch, { ledger: s.ledger, propose: s.propose, extract: async () => "[]" });
      assert.equal(calls, 1, "committed 后不再调模型");
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });
});

describe("buildExtractionPrompt", () => {
  test("包含索引化消息与类型枚举", () => {
    const records = fixtureRecords(2);
    const batch = records.map((r) => ({ record: r, eventKey: r.eventKey }));
    const p = buildExtractionPrompt(batch);
    assert.match(p, /\[0\] \(dsh:session-t:seq-0\)/);
    assert.match(p, /decision\|fact\|preference/);
    assert.match(p, /宁缺毋滥/);
  });
});
