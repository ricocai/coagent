/**
 * session-capture 单元测试。
 * 重点锁定的都是「安全性质」——注入材料不得回流、密钥不得出网、
 * 重复采集不得翻倍。这些是记忆库数据质量的底线，不能用肉眼抽检。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractMessage,
  redact,
  buildCaptureEvent,
  planCapture,
  listSessions,
  SESSION_FILE,
} from "../../adapter/lib/session-capture.js";
import { makeEventKey } from "../../adapter/lib/outbox.js";

const SID = "session-test-abc";
const PROJECT = "personal-agent";

function rec(seq, type, data, extra = {}) {
  return { type, seq, time: 1790000000000 + seq * 1000, data, ...extra };
}

// ------------------------------------------------------------------ 过滤

test("真人用户消息才回流；注入材料一律跳过", () => {
  // PGM 召回注入（结构判定：source.kind !== user）
  const injected = rec(
    8,
    "user/message",
    {
      id: "pgm-context:ctx_x",
      role: "user",
      content: [{ type: "text", text: "[PGM 个人全局记忆 · project=personal-agent]" }],
      source: { kind: "plugin", plugin: "pgm-harness-adapter", form: "recall" },
    },
    { surfaceOp: true },
  );
  assert.equal(extractMessage(injected), null, "注入召回必须跳过：否则形成记忆污染循环");

  // 系统提示快照
  const sysSnap = rec(10, "user/message", {
    content: [{ type: "text", text: "You are a helpful assistant..." }],
    source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot" },
  });
  assert.equal(extractMessage(sysSnap), null, "系统提示快照不回流");

  // 技能目录
  const catalog = rec(11, "user/message", {
    content: [{ type: "text", text: "可用技能列表" }],
    source: { kind: "skill-catalog", form: "catalog" },
  });
  assert.equal(extractMessage(catalog), null, "技能目录不回流");

  // 真人输入
  const human = rec(9, "user/message", {
    content: [{ type: "text", text: "为什么决定用 X 方案" }],
    source: { kind: "user", rpcId: "abc" },
  });
  const got = extractMessage(human);
  assert.equal(got?.role, "user");
  assert.equal(got.text, "为什么决定用 X 方案");
});

test("注入文本即使伪装成 user source 也被拦截（双重把关）", () => {
  const tricky = rec(1, "user/message", {
    content: [{ type: "text", text: "[PGM 个人全局记忆 · project=p] 背景材料" }],
    source: { kind: "user" }, // 结构判定被绕过的情况
  });
  assert.equal(extractMessage(tricky), null, "文本标记兜底必须生效");
});

test("助手消息默认不含 reasoning", () => {
  const assistant = rec(16, "assistant/message", {
    turn: 1,
    step: 1,
    message: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "内部推理过程" },
        { type: "text", text: "结论：采用方案 A" },
      ],
    },
  });
  assert.equal(extractMessage(assistant).text, "结论：采用方案 A");
  const withReasoning = extractMessage(assistant, { includeReasoning: true });
  assert.match(withReasoning.text, /内部推理过程/);
});

test("工具调用与结果默认不采集（实测其中含 API key）", () => {
  const call = rec(17, "tool/call", { turn: 1, step: 1, callId: "t1", name: "web_search", arguments: "{}" });
  const result = rec(21, "tool/result", {
    turn: 1,
    step: 1,
    message: {
      source: { kind: "tool", callId: "t1" },
      content: [{ type: "tool-result", toolCallId: "t1", content: [{ type: "text", text: "Error: api key sk-live-abc123def456ghi789" }] }],
    },
  });
  assert.equal(extractMessage(call), null, "默认排除 tool/call");
  assert.equal(extractMessage(result), null, "默认排除 tool/result");
  assert.equal(extractMessage(call, { includeTools: true })?.role, "tool");
  assert.match(extractMessage(result, { includeTools: true }).text, /Error: api key/);
});

test("控制面记录（turn/step/permission 等）不回流", () => {
  for (const t of ["turn/start", "step/end", "permission/preset", "approval/policy", "session/title"]) {
    assert.equal(extractMessage(rec(3, t, { foo: 1 })), null, `${t} 不应回流`);
  }
});

// ------------------------------------------------------------------ 脱敏

test("敏感信息脱敏后才出网", () => {
  const cases = [
    ["我的 api_key = abcdefgh12345678", /\[REDACTED\]/],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef", /Bearer \[REDACTED\]/],
    // 注意：这里必须用合成令牌，绝不可使用真实签发凭证
    // （曾误将真实令牌写入测试并推入公开仓库，须靠轮换 + 历史清理处置）。
    ["令牌是 pgm-EXAMPLEFAKE0123456789abcdefghijXY", /\[REDACTED_PGM_TOKEN\]/],
    ["sk-A1b2C3d4E5f6G7h8I9j0K1l2M3n4", /\[REDACTED_KEY\]/],
    ["ghp_abcdefghijklmnopqrstuvwxyz123456", /\[REDACTED_GITHUB_TOKEN\]/],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----", /\[REDACTED_PRIVATE_KEY\]/],
  ];
  for (const [input, expect] of cases) {
    const { text, redacted } = redact(input);
    assert.equal(redacted, true, `应识别为敏感: ${input}`);
    assert.match(text, expect);
  }
  // 正常文本不得误伤
  const normal = redact("今天讨论了 PGM 与 Harness 的集成方案");
  assert.equal(normal.redacted, false);
  assert.equal(normal.text, "今天讨论了 PGM 与 Harness 的集成方案");
});

// ------------------------------------------------------------------ 幂等与截断

test("同一 (session, seq) 生成的幂等键稳定", () => {
  const msg = { role: "user", text: "同一句话", seq: 42, time: 1790000000000, source: "user/message" };
  const a = buildCaptureEvent({ sessionId: SID, projectId: PROJECT, msg });
  const b = buildCaptureEvent({ sessionId: SID, projectId: PROJECT, msg });
  assert.equal(a.event.event_id, b.event.event_id);
  assert.equal(makeEventKey(a.event), makeEventKey(b.event));
  assert.match(a.event.event_id, /^dsh:session-test-abc:42$/);
});

test("超长正文截断并标注，空正文被拒", () => {
  const long = { role: "user", text: "x".repeat(100), seq: 1, time: 1, source: "user/message" };
  const out = buildCaptureEvent({ sessionId: SID, projectId: PROJECT, msg: long, maxChars: 30 });
  assert.equal(out.truncated, true);
  assert.match(out.event.content[0].text, /截断 70 字符/);

  assert.throws(
    () =>
      buildCaptureEvent({
        sessionId: SID,
        projectId: PROJECT,
        msg: { role: "user", text: "   ", seq: 2, time: 1, source: "user/message" },
      }),
    /text 不能为空/,
  );
});

// ------------------------------------------------------------------ planCapture 集成（含游标）

function makeWorkspace(recordSets) {
  const root = mkdtempSync(join(tmpdir(), "pgm-cap-"));
  const sessions = join(root, "sessions");
  const byPath = new Map();
  let i = 0;
  for (const records of recordSets) {
    const dir = join(sessions, `--cwd-${i}--`, `session-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, SESSION_FILE), "dummy");
    byPath.set(join(dir, SESSION_FILE), records);
    i += 1;
  }
  const readImpl = (file) => ({ records: byPath.get(file) ?? [], header: null, malformed: 0 });
  return { sessions, readImpl };
}

test("游标生效：二次采集不重复、增量为零", () => {
  const records = [
    rec(1, "user/message", { content: [{ type: "text", text: "第一条" }], source: { kind: "user" } }),
    rec(2, "user/message", {
      content: [{ type: "text", text: "[PGM 个人全局记忆]" }],
      source: { kind: "plugin", form: "recall" },
    }),
    rec(3, "assistant/message", { message: { content: [{ type: "text", text: "回答" }] } }),
  ];
  const ws = makeWorkspace([records]);
  const first = planCapture({ sessionsDir: ws.sessions, projectId: PROJECT, readImpl: ws.readImpl });
  assert.equal(first.events.length, 2, "1 用户 + 1 助手，注入被跳过");
  assert.equal(first.stats.skippedInjected, 1);

  const second = planCapture({
    sessionsDir: ws.sessions,
    projectId: PROJECT,
    cursors: first.cursors,
    readImpl: ws.readImpl,
  });
  assert.equal(second.events.length, 0, "游标之后无新增 → 不重复采集");
  assert.deepEqual(second.cursors, first.cursors, "游标不推进");
});

test("会话目录不存在时安全返回空，不抛错", () => {
  assert.deepEqual(listSessions("/no/such/dir"), []);
  const empty = planCapture({ sessionsDir: "/no/such/dir", projectId: PROJECT });
  assert.equal(empty.events.length, 0);
});

test("注入跳过数量在 plan 层可观测", () => {
  const records = [
    rec(1, "user/message", { content: [{ type: "text", text: "真问题" }], source: { kind: "user" } }),
    rec(2, "user/message", { content: [{ type: "text", text: "recall" }], source: { kind: "plugin", form: "recall" } }),
    rec(3, "user/message", { content: [{ type: "text", text: "recall2" }], source: { kind: "plugin", form: "recall" } }),
  ];
  const ws = makeWorkspace([records]);
  const plan = planCapture({ sessionsDir: ws.sessions, projectId: PROJECT, readImpl: ws.readImpl });
  assert.equal(plan.stats.skippedInjected, 2);
  assert.equal(plan.stats.candidates, 1);
});
