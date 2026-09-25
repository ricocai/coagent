# SOP: context-pack（上下文打包与交接）

输入：PGM 上下文包、获准来源、用户反馈
输出：记忆候选与任务交接包
检查点：不绕过 PGM 确认；保留来源与版本

## 步骤

1. 就绪检查：`pgm-ctl ready`。失败 → 报告阻塞，不用本地旧文件冒充有效记忆。
2. 构建上下文：`pgm-ctl build --purpose "<任务用途>" [--query "<关键词>"]`
   记下 `snapshot_id`、`policy_revision`、`scope_revisions`、`expires_at`。
3. 区分三类内容（角色测试）：
   - 用户已确认决定（status=active 的 decision）
   - 助手建议（未确认，不得写成决定）
   - 未决问题（open_questions / conflicts）
4. 产物中每条重要结论附 `[E:ev_xxx]` 或 `[M:mem_id@v]` 引用。
5. 需要更新长期记忆时：只 `pgm-ctl propose ...` 提交候选；不改确认状态。
6. 任务结束：
   - `memory.events_queue` / `pgm-ctl events:queue` 只排队本轮原生消息；
   - `pgm-ctl events:flush` 幂等回传；
   - `personalctl run record --stage context-pack --file <产物>` 记账。
7. 模型请求前、有副作用工具前、外发前：`pgm-ctl validate <snapshot_id>`，
   非 `valid` 一律重建上下文，不得拿旧包继续。

## 交接包要求

文件头必须包含：`snapshot_id:`、项目、目的地路由、生成时间、过期时间。
只摘录获准范围的内容给外部工具；对方读不到本机路径，要给内容不是路径。
