# Cloudflare Cron 交易时段快照设计

## 目标

为现有 Worker 增加每 5 分钟触发一次的 Cloudflare Cron Trigger。Scheduled Handler 使用触发时间按北京时间判断是否处于交易时段，只有交易时段才把新的模拟基金快照写入 KV。

交易时段定义为周一至周五的 `09:30–11:30` 和 `13:00–15:00`，开始与结束时刻均包含。当前阶段不处理中国法定节假日、调休或临时休市。

## 配置

`with_kv` Wrangler 环境配置 Cron 表达式 `*/5 * * * *`，全天每 5 分钟触发。基础环境继续不配置 KV 和 Cron，保持无绑定运行能力。

本地定时任务测试使用 Wrangler 的 scheduled handler 测试入口。

## 时间判断

Scheduled Handler 使用 `controller.scheduledTime`，不使用实际执行开始时间。将毫秒时间戳加 8 小时后，使用 UTC 日期方法读取北京时间的星期、小时和分钟，避免依赖运行环境时区或夏令时。

判断条件：

- 星期为周一至周五。
- 当天分钟数位于 `570–690`，对应 `09:30–11:30`；或位于 `780–900`，对应 `13:00–15:00`。

## KV 写入职责

Scheduled Handler 是 `fund_snapshot_latest` 的唯一写入者：

1. 非交易时段记录结构化 `cron_skipped_outside_trading_session` 日志并正常结束。
2. 交易时段但未配置 `FUND_CACHE` 时记录 `cron_skipped_no_kv` 并正常结束。
3. 交易时段且 KV 可用时，按 `controller.scheduledTime` 生成模拟快照，以 `expirationTtl: 300` 写入 KV，并记录 `cron_snapshot_updated`。
4. KV 写入失败时不吞掉异常，让 Cron Trigger 事件记录显示失败。

HTTP `GET /api/funds` 只读取 KV。命中时返回缓存；未配置 KV、未命中、缓存无效或读取失败时返回即时模拟快照，但不写 KV。这样非交易时段的普通访问不会更新 KV。

响应头语义调整为：

- `HIT`：命中 KV。
- `MISS`：KV 已配置但未命中，返回临时模拟快照且未写入。
- `BYPASS`：未配置 KV。
- `ERROR`：KV 读取失败，已降级。

## 验证

- 运行 `wrangler types` 更新 Scheduled Handler 与环境类型。
- 运行 `npm run typecheck`。
- 分别 dry-run 基础环境和 `with_kv` 环境。
- 验证工作日上午、午休、工作日下午、周末和结束边界的交易时段判断。
- 本地触发 Scheduled Handler，确认交易时段写入、非交易时段跳过。
- 确认普通访问未命中时不会写入 KV。
