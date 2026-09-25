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
│   ├── bin/pgm-adapter.mjs #   MCP stdio server（newline-delimited JSON-RPC）
│   └── bin/pgm-ctl.mjs     #   CLI：health/ready/search/build/validate/evidence/propose/events:*
├── tools/personalctl/      # 业务确定性工具（artifact check / run record / report render）
├── sop/                    # context-pack / research-brief / session-review
├── .dsh/skills/            # 同名三个 Skill（dsh 发现根）
├── evals/
│   ├── unit/               # 19 个单元测试（mock PGM，node --test）
│   ├── integration.mjs     # 真实 PGM 六条必过验收（§3.4，未就绪自动跳过）
│   └── fixtures/           # 三份合成验收材料
├── adr/ADR-0001-harness-integration.md
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
```

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

## 安全边界

- `PGM_TOKEN` 只经环境变量；`.env*` 不进 Git（仅 `.env.example`）。
- 本客户端无审批权：propose 只写候选，confirm/reject 是 PGM 管理身份操作。
- `context/ outputs/ feedback/ runs/ state/` 均不进 Git。
- 云端目的地双重过滤：服务端 scope 过滤 + 客户端 local_only 泄漏检查。
