# ADR-0001: Harness 集成与 PGM 适配器契约

状态：已接受 ｜ 日期：2026-09-25 ｜ 决策人：Rico ｜ 实现：Axiom（WorkBuddy）

## 背景

`design/deepseek_harness_personal_agent_poc.md`（v0.4，2026-09-25）要求：
先有独立 Global Memory（PGM），再接入 DeepSeek Harness 客户端。
PGM 由并列项目 `~/c-doing/global-mem`（Kimi 实现）交付；本仓库（coagent）
承载客户端侧：受限适配器、事件回流、业务工具、SOP/Skills 与验收集。

## 决策

1. **仓库根**：`~/c-doing/c-agent/workspace`，remote = `https://github.com/ricocai/coagent`。
   选 workspace 而非 c-agent 上层：设计 §3.2 规定 workspace 为独立 Git 根，
   且 dsh 技能发现以"最近 `.git` 祖先"为 projectRoot（§6.3），
   `workspace/.dsh/skills/` 恰好落在仓库内，Skills 发现与版本管理一致。
   `context/ outputs/ feedback/ runs/ evals/private/ state/` 不进 Git（§3.2）。

2. **适配器形态**：**MCP stdio server + 同逻辑 CLI（pgm-ctl）双通道**，零第三方依赖
   （Node ≥22.19 内置 fetch/test/child_process）。
   - MCP：Harness 支持插件/MCP 扩展点时直接挂载（工具集 memory.*）；
   - CLI：Harness 插件接口未锁定前，Agent 经 shell 工具调用同一套能力。
   不复制 PGM 数据、不建第二套记忆库（§7/§8）。

3. **destination 绑定**：由启动配置（env `PGM_DESTINATION`）绑定真实模型路由，
   工具调用方无法改写（§4.3）。`cloud:*` 目的地在客户端做 local_only/secret_excluded
   深度复核（§11.7），与服务端过滤互为防线。

4. **validate 去重**（§8.1.1）：singleflight 仅合并并发在途同 key 只读校验；
   `completed_validation_cache_ttl_ms = 0`，完成即失效。有副作用操作调用方须重发校验。

5. **事件回流**：outbox JSONL（state 目录，不进 Git），eventKey 与服务端 source_key
   同构 `connector|account_ref|conversation_id|message_id|revision`；
   2xx 回执才标记 committed；`origin=injected_context` 在客户端即拒绝（§8.2）。
   POC 阶段原生会话采集依赖 Harness 锁定版本的插件钩子，当前以显式入队过渡——
   这是已知缺口，不是完整采集。

6. **PGM 契约**：对齐 `global-mem/packages/contracts/pgm.context.v1.json`（快照）、
   `pgm.event.v1.json`（事件）与 `apps/memoryd/pgm/service.py` 路由
   （healthz / search / context:build / context:validate / evidence / events:batch /
   proposals）。客户端对 schema_version 强校验，状态码 200 不视为兼容（§3.3）。

## Harness 安装记录（待补）

按设计 §4.1：安装前 `npm view @deepseek-ai/dsh dist-tags/versions/time --json`
重新查询，显式选精确版本再 `npm install --save-exact`。
本 ADR 安装段需记录：查询时间与 registry、dist-tags 快照、所选版本、
发布时间、稳定/RC 轨道、Node/npm 版本、包完整性、gitHead、profile 备份标识。
**当前状态：dsh 尚未安装，此段留空待装机时补录。**

## 验收证据

- 单元测试：`node --test "evals/unit/**/*.test.mjs"` → 19/19 通过（2026-09-25，Node 22.22.2）
  覆盖：幂等回流、injected_context 拒绝、singleflight 边界、schema 校验、
  403 映射、local_only 深度防御、MCP 端到端、personalctl 三命令。
- 集成验收：`PGM_TOKEN=... node evals/integration.mjs`（PGM 未就绪自动跳过；
  PGM 通过阶段 B 验收后执行六条必过项）。

## 后果与风险

- 零依赖 JS（非 TS）：换取"免构建、Node 直接跑"，POC 阶段可接受；若复杂度上升再迁移 TS。
- MCP 协议手工实现最小子集（initialize/tools/list/tools/call）：
  若 Harness 锁定版要求特定 MCP 版本或能力，需在装机时对齐并补测试。
- 原生会话自动采集未实现，依赖 dsh 插件接口锁定（§8 后续阶段）。
