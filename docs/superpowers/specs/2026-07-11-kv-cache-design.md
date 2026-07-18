# Cloudflare KV 基金快照缓存设计

## 目标

为 `GET /api/funds` 增加可选的 Cloudflare KV 缓存。缓存键固定为 `fund_snapshot_latest`，缓存有效期为 300 秒。项目在未配置 KV、KV 读取失败或 KV 写入失败时仍正常返回模拟数据。

## Wrangler 环境与绑定

基础环境不声明 KV，继续支持 `npm run dev`、默认部署和无 KV 运行。

新增 `with_kv` Wrangler 环境，并声明名为 `FUND_CACHE` 的 KV 绑定。绑定省略资源 ID，由 Wrangler 在部署该环境时自动配置资源。运行 `wrangler types` 后，跨环境生成的 `Env` 类型将 `FUND_CACHE` 标记为可选。

提供两个部署路径：

- `npm run deploy`：基础环境，不使用 KV。
- `npm run deploy:kv`：`with_kv` 环境，使用 KV。

## 请求数据流

`GET /api/funds` 的处理顺序：

1. 检查 `env.FUND_CACHE` 是否存在。
2. 不存在时生成模拟快照并直接返回，响应头为 `X-Fund-Cache: BYPASS`。
3. 存在时，以 `cacheTtl: 300` 读取 `fund_snapshot_latest`。
4. 缓存值通过运行时结构校验后直接返回，响应头为 `X-Fund-Cache: HIT`。
5. 未命中或缓存内容无效时生成新快照，以 `expirationTtl: 300` 写入 KV，再返回新快照，响应头为 `X-Fund-Cache: MISS`。
6. KV 读写抛出异常时记录结构化警告并返回新快照，响应头为 `X-Fund-Cache: ERROR`。

KV 中只保存 `FundsPayload`，API 外层统一响应格式保持不变。`GET /api/health` 不读取或写入 KV。

## 错误处理

缓存是可选加速层，不是接口正确性的前置条件。KV 读取、解析、校验或写入失败均不得让 `/api/funds` 返回错误。所有 Promise 都显式等待，避免后台写入被丢弃。

缓存中出现旧格式或损坏内容时按未命中处理并覆盖。日志不包含基金以外的用户数据或秘密。

## 验证

- 运行 `wrangler types` 生成绑定类型。
- 运行 `npm run typecheck`，确保可选绑定分支通过严格 TypeScript 检查。
- 运行基础环境 dry-run，验证无 KV 配置可构建。
- 运行 `with_kv` 环境 dry-run，验证 KV 绑定可构建。
- 本地基础环境请求 `/api/funds`，确认 `X-Fund-Cache: BYPASS`。
- 本地 `with_kv` 环境连续请求两次，确认第一次 `MISS`、第二次 `HIT`。
