# evals/fixtures — 合成验收材料（§3.4）

三份合成材料对应前置验收样本：

| 文件 | 预期处理 |
|---|---|
| `source-a-langgraph-discussion.md` | "助手建议 LangGraph/Harness" → 保持建议（candidate），不成为决定 |
| `source-b-harness-decision.md` | "用户本轮选择 Harness/PGM 架构" → 人工确认后为 active decision |
| `source-c-youdao-open-question.md` | "是否自动导入有道尚未决定" → 保持未决（open question） |

必须通过的验收（用 `evals/integration.mjs` 对真实 PGM 执行）：
1. 同包导入两次不重复（source_key 幂等）；
2. 生成的上下文只把第二条作为当前决定；
3. 另一项目令牌无权读取（403）；
4. `local_only` 内容对云端目的地（kimi）被排除；
5. 更正/撤回后旧快照失效（validate 拒绝）；
6. 服务重启仍能返回正确版本。

全部为合成/脱敏样本；私密历史在边界验证通过后才导入。
