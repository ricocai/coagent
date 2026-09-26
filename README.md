# coagent — 个人 Agent 客户端侧（DeepSeek Harness + PGM 适配）

> 面向个人、中小企业的轻量型智能体

设计文档：`~/c-doing/c-agent/design/deepseek_harness_personal_agent_poc.md`（v0.4）
PGM 服务端：`~/c-doing/c-agent/../global-mem`（并列项目，独立仓库）

本仓库承载 **客户端侧**：PGM 受限适配器、事件回流、业务确定性工具、SOP/Skills、验收集。

```
workspace/                  ← 本仓库（Git 根 = dsh 技能发现 projectRoot）
├── adapter/                # personal-context 适配器
│   ├── lib/pgm-client.js   #   PGM 受限客户端（6 接口、singleflight validate、local_only 复核）
│   ├── lib/outbox.js       #   事件回流队列（幂等、崩溃安全）
│   ├── lib/tools.js        #   工具实现（MCP 与 CLI 共用）
│   ├── lib/session-capture.js #  dsh 会话原生采集（过滤注入/脱敏/幂等）
│   ├── lib/distill.js      #   事件→候选记忆提炼（本地模型/无工具/两阶段 ledger）
│   ├── bin/pgm-adapter.mjs #   MCP stdio server（newline-delimited JSON-RPC）
│   ├── bin/pgm-ctl.mjs     #   CLI：health/ready/search/build/validate/evidence/propose/events:*
│   ├── bin/pgm-session-capture.mjs # CLI：会话原生采集（once/watch/dry-run）
│   └── bin/pgm-distill.mjs #   CLI：记忆提炼（dry-run/retry-pending/status）
├── tools/personalctl/      # 业务确定性工具（artifact check / run record / report render）
├── sop/                    # context-pack / research-brief / session-review
├── .dsh/skills/            # 同名三个 Skill（dsh 发现根）
├── evals/
│   ├── unit/               # 50 个单元测试（mock PGM/模型，node --test）
│   ├── integration.mjs     # 真实 PGM 六条必过验收（§3.4，未就绪自动跳过）
│   └── fixtures/           # 三份合成验收材料
├── adr/ADR-0001-harness-integration.md   # 及 ADR-0002（会话采集）、ADR-0003（提炼管线）
├── config/                 # 配置示例
├── scripts/setup.sh        # 目录初始化
└── context/ outputs/ feedback/ runs/   # 运行产物，不进 Git
```

## 快速开始

```bash
# 1. 初始化目录（context/outputs/feedback 等）
./scripts/setup.sh

# 2. PGM 侧签发 Agent 令牌（在 global-mem 项目；管理身份执行）
#    pgm token issue --client-id dsh-coagent --projects personal-agent \
#      --data-levels public,personal --destinations mtplx,cloud:kimi

# 3. 安全注入环境变量（勿写入文件/日志）
export PGM_TOKEN="<上一步签发的令牌>"
export PGM_PROJECT=personal-agent
export PGM_DESTINATION=mtplx          # 与实际模型路由一致；云端为 cloud:kimi

# 4. 验证
adapter/bin/pgm-ctl.mjs ready         # 存活 + 授权双重检查
node --test "evals/unit/**/*.test.mjs"
PGM_TOKEN=$PGM_TOKEN node evals/integration.mjs

# 5. 挂到 Harness（MCP）：command=node, args=[.../adapter/bin/pgm-adapter.mjs]，
#    env 同上。CLI 通道可直接在 Agent shell 里调 pgm-ctl。

# 6. 会话原生采集（把真实对话自动回流，替代“靠模型自觉入队”）
adapter/bin/pgm-session-capture.mjs --dry-run     # 先看清楚采什么
adapter/bin/pgm-session-capture.mjs               # 落 outbox 并推送 PGM
adapter/bin/pgm-session-capture.mjs --watch 60    # 持续增量采集
```

## 会话原生采集（自动记忆回流）

依赖模型/SOP 显式入队会漏记；dsh 已把会话追加写入
`$DSH_HOME/sessions/<cwd>/session-<uuid>/session.v3.jsonl.zstd`，
这里直接读快照做采集，**不需要任何 dsh 内部插件接口**。

| 行为 | 说明 |
|---|---|
| 采集什么 | `source.kind === "user"` 的用户提问 + 助手最终结论；默认不含 reasoning、不含工具调用/结果 |
| 过滤注入 | PGM 召回注入（`plugin/pgm-harness-adapter`）、系统提示快照、技能目录全部跳过，切断「记忆→注入→再采集」污染循环 |
| 脱敏 | 密钥/令牌/私钥模式先脱敏再出网（`sk-*`、Bearer、`pgm-`、api_key=…），工具结果默认不采（实测含 API key） |
| 幂等 | `message_id = dsh:<sessionId>:<seq>` + outbox eventKey 去重 + 服务端 source_key 幂等 |
| 断点续采 | 游标存 `state/dsh/capture-cursors.json`，重跑零重复、零重复扫描 |
| 外部依赖 | `zstd` CLI。会话是多帧 zstd，Node 原生 zlib 只能读到首帧（`Unknown frame descriptor`）；可用 `PGM_ZSTD_BIN` 指定 |

常用参数：`--dry-run`（预览不推送）、`--watch [秒]`（轮询）、`--include-tools`（慎含密钥）、
`--include-reasoning`、`--max-chars N`、`--limit N`、`--json`。

## 记忆提炼（事件 → 候选记忆，ADR-0003）

把 outbox 中已 committed 的**用户事件**经本地模型抽取为结构化候选记忆，提交到
PGM 确认收件箱（`POST /v1/proposals`，附 evidence_ids 可回溯原始事件）。

```bash
adapter/bin/pgm-distill.mjs --dry-run    # 预览将处理的事件
adapter/bin/pgm-distill.mjs              # 本地模型抽取 → 提交候选
adapter/bin/pgm-distill.mjs --status     # ledger 统计
adapter/bin/pgm-distill.mjs --retry-pending   # 模型曾不可达时恢复 pending 批次
```

| 约束（§11.7） | 实现 |
|---|---|
| 只走本地模型 | 默认 MTPLX `127.0.0.1:8001`；非回环端点默认拒绝，`--allow-remote` 显式越过 |
| 无执行工具 | 请求体不带 `tools`/`tool_choice`，单测锁定 |
| 只提候选 | 只调 propose，绝不 decide；审批权在用户 |
| 只信真人输入 | 仅 `role=user` 事件（助手建议≠用户决定，§12.5） |
| 宁缺毋滥 | 空抽取合法并 committed；schema 严格校验；敏感度继承来源最高级 + 二次脱敏 |
| 幂等 | 两阶段 ledger（pending→committed），崩溃后 `--retry-pending` 恢复 |

候选需在 PGM 收件箱确认后生效；模型离线时提炼暂停（批次留在 pending），不影响采集与读取。


> 已写入的事件可用 PGM `/v1/deletions:preview` 按 `source_key` 精确核实与删除，
> key 形如 `dsh-harness|local|<sessionId>|dsh:<sessionId>:<seq>|1`。

## 验收对照（设计 §3.4 / §12.5）

| 验收 | 位置 |
|---|---|
| 同包导入两次不重复 | `outbox.test` + `integration.mjs` #1 |
| 跨项目令牌 403 | `pgm-client.test` + `integration.mjs` #4 |
| local_only 不进云端 | `pgm-client.test`（深度防御）+ `integration.mjs` #5 |
| validate 失效拒绝 | `pgm-client.test`（stale→409）+ `integration.mjs` #7 |
| 事件幂等回流 | `outbox.test` + `integration.mjs` #6 |
| 角色测试（建议≠决定） | `tools.js` propose 只写候选；fixture A/B/C |
| 重启恢复 | outbox JSONL 落盘重放（`outbox.test` 失败恢复用例） |
| 会话自动采集且不污染 | `session-capture.test`（注入跳过 / 脱敏 / 幂等 / 游标续采）+ 真实会话 dry-run 与实采（4 会话→21 事件，跳过 24 条注入） |

## 安全边界

- `PGM_TOKEN` 只经环境变量；`.env*` 不进 Git（仅 `.env.example`）。
- 本客户端无审批权：propose 只写候选，confirm/reject 是 PGM 管理身份操作。
- `context/ outputs/ feedback/ runs/ state/` 均不进 Git。
- 云端目的地双重过滤：服务端 scope 过滤 + 客户端 local_only 泄漏检查。
