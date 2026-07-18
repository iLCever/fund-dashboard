# 天天基金 Provider 适配层设计

## 目标

在不改变前端统一数据结构的前提下，为 Worker 增加天天基金 `fundgz` 第三方接口适配层。所有第三方请求、JSONP 解析、响应校验、超时、并发控制和单基金降级逻辑集中在 `src/providers/fundProvider.ts`。

保留模拟数据模式。实时模式下，任意单只基金失败不得影响其他基金或整个快照。

## 数据源与模式开关

天天基金单基金接口：

```text
https://fundgz.1234567.com.cn/js/{fundCode}.js
```

响应为 `jsonpgz({...});` JSONP。Provider 只读取：

- `fundcode`：基金代码。
- `dwjz`：昨日净值。
- `gsz`：估算净值。
- `gszzl`：估算涨幅。
- `gztime`：估值时间。

可选环境变量 `FUND_DATA_MODE` 控制模式：

- 未配置或 `mock`：全部使用模拟数据。
- `live`：请求天天基金，单只失败时仅该基金回退模拟数据。
- 其他值：为避免意外外部请求，按 `mock` 处理并记录警告。

## Provider 接口

`fundProvider.ts` 导出一个批量获取函数，输入基金配置、当前时间和数据模式，输出：

- `funds`：完整 `FundEstimate[]`，数量和输入配置一致。
- `isMock`：模拟模式或任一基金发生回退时为 `true`，全部实时成功时为 `false`。

基金名称、分类、产品类型和默认选择状态始终来自 `src/config.ts`，不信任第三方名称。输出保持分类顺序，并在每个分类内按估算涨幅降序排列。

## 并发与超时

实时模式使用固定任务池，Worker 数量为 `min(5, 基金数量)`，因此最大并发数为 5。任务索引只存在于单次函数调用内，不保存模块级请求状态。

每只基金使用独立的 8 秒 `AbortSignal.timeout()`。超时覆盖连接、响应头和响应正文读取。

第三方响应正文通过流读取，并限制最大 64 KiB。超过限制立即取消读取并将该基金降级，避免无界 `response.text()`。

## 解析与隔离

每只基金请求包含在独立 `try/catch` 中。以下情况触发该基金模拟降级：

- 网络错误或 8 秒超时。
- 非 2xx HTTP 状态。
- 空响应、响应超过 64 KiB 或 JSONP 外壳错误。
- JSON 解析失败。
- 基金代码不匹配。
- 净值、涨幅或时间字段缺失、非数字或非有限值。

失败日志包含事件名、基金代码和错误信息，不包含秘密。任务池使用 `Promise.all` 等待固定数量的 Worker；每个 Worker 内逐只处理，因此不存在未处理的 Promise 拒绝。

## 与现有数据流集成

`src/index.ts` 不再直接生成模拟基金数组，而是调用 Provider：

- HTTP `/api/funds`：KV 命中则返回缓存；未命中则调用 Provider，但不写 KV。
- Cron：交易时段调用 Provider，然后写入 KV。
- `/api/health`：保持原格式，`isMock` 根据当前模式判断。

`FundsPayload` 字段保持不变。`isMock` 从字面量 `true` 放宽为 `boolean`，JSON 字段名称和结构不变。

## 验证

- 运行 `wrangler types` 生成 `FUND_DATA_MODE` 类型。
- 运行 `npm run typecheck`。
- 模拟模式验证不发出第三方请求且输出完整。
- 实时模式验证全部成功映射。
- 验证单只超时、非 2xx、JSONP 损坏、字段异常时仅该基金回退。
- 使用受控测试服务测量同时在途请求数不超过 5。
- dry-run 基础环境和带 KV/Cron 环境。
