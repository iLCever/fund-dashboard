# 基金估值看板

一个部署在 Cloudflare Workers 免费版上的个人基金盘中估算看板。Worker 统一请求第三方基金接口、标准化数据、分类排序、缓存快照并提供 API；浏览器只请求同源 Worker，不直接访问第三方接口。

> 盘中估算不是基金管理人公布的正式净值，仅供个人信息整理，不构成投资建议。

## 功能

- 基金配置集中在 `src/config.ts` 的 `FUND_LIST`。
- 天天基金 `fundgz` JSONP 适配器集中在 `src/providers/fundProvider.ts`。
- 展示基金名称、代码、自定义分类、估算涨幅、估算净值、上一交易日净值、更新时间和状态。
- 分类分组、分类内排名、涨幅升降序切换、名称/代码/分类搜索。
- 单只基金失败不会影响其他基金；失败基金保留在结果中。
- 最大并发数 5，每只请求默认超时 8 秒。
- KV 快照缓存、300 秒新鲜度判断、60 秒刷新锁和旧缓存降级。
- 每 5 分钟 Cron Trigger；仅在北京时间工作日 `09:30–11:30`、`13:00–15:00` 更新。
- 强制刷新需要 Cloudflare Secret `REFRESH_TOKEN`。
- 原生 HTML/CSS/JavaScript，支持手机横向滚动和浅色/深色模式。
- 页面每 60 秒读取 Worker，网络失败时保留已展示数据。

## 项目结构

```text
fund-dashboard/
├─ public/
│  ├─ index.html
│  ├─ style.css
│  ├─ app.js
│  ├─ favicon.svg
│  └─ _headers
├─ src/
│  ├─ index.ts
│  ├─ config.ts
│  ├─ types.ts
│  ├─ utils.ts
│  └─ providers/
│     ├─ fundProvider.ts
│     └─ providerTypes.ts
├─ wrangler.example.jsonc
├─ wrangler.jsonc              # 本地配置，不提交
├─ package.json
├─ tsconfig.json
├─ README.md
└─ .gitignore
```

## 环境要求

- Node.js 20 或更高版本：<https://nodejs.org/>
- npm
- Cloudflare 账号

确认版本：

```bash
node --version
npm --version
```

## 安装依赖

```bash
cd fund-dashboard
npm install
```

复制公开配置模板：

```powershell
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

macOS/Linux：

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc` 可能包含个人 KV ID 和自定义域名，因此已加入 `.gitignore`，不会上传到公开仓库。

## Cloudflare 登录

```bash
npx wrangler login
npx wrangler whoami
```

## KV 配置

项目使用绑定名 `FUND_CACHE`，键名如下：

```text
fund_snapshot_latest
fund_refresh_lock
```

由模板复制出的 `wrangler.jsonc` 采用 Wrangler 自动资源配置：KV 绑定不填写 `id`，首次部署时 Wrangler 会自动创建并写回资源配置。

如需手动创建：

```bash
npx wrangler kv namespace create FUND_CACHE
```

然后将返回的 ID 填入本地 `wrangler.jsonc`：

```jsonc
"kv_namespaces": [
  {
    "binding": "FUND_CACHE",
    "id": "这里填写KV ID"
  }
]
```

## 配置强制刷新 Secret

生产环境必须设置：

```bash
npx wrangler secret put REFRESH_TOKEN
```

命令会安全地提示输入密钥。不要把密钥写入源码、`wrangler.jsonc` 或前端。

本地开发可创建未提交的 `.dev.vars`：

```text
REFRESH_TOKEN=your-local-refresh-token
```

## 环境变量

非敏感变量在 `wrangler.jsonc` 中配置：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `USE_MOCK_DATA` | `false` | `true` 时完全使用模拟数据 |
| `FUND_API_URL` | 天天基金 fundgz URL | 使用 `{code}` 作为基金代码占位符 |
| `FUND_API_TIMEOUT` | `8000` | 单只基金超时毫秒数，允许 1000–30000 |
| `CACHE_TTL` | `300` | 快照新鲜时间秒数，允许 60–3600 |
| `MAX_CONCURRENCY` | `5` | 第三方最大并发数，允许 1–5 |

## 本地运行

实时接口模式：

```bash
npm run dev
```

模拟数据模式：

```bash
npm run dev:mock
```

通常访问：

```text
http://localhost:8787
```

## 本地测试定时任务

```bash
npm run dev:cron
```

另开终端触发：

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?format=json"
```

模拟特定触发时间可传入 UTC 毫秒时间戳：

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?format=json&cron=*/5+*+*+*+*&time=1783906200000"
```

## API

### 全部基金

```text
GET /api/funds
```

### 分类筛选

```text
GET /api/funds?category=指数型
```

### 搜索

```text
GET /api/funds?keyword=黄金
```

支持名称、代码和分类，英文不区分大小写。

### 强制刷新

```text
GET /api/funds?refresh=1&token=你的密钥
```

密钥只用于手动调用，不应放入前端。普通页面刷新按钮不会强制刷新第三方接口。

### 健康检查

```text
GET /api/health
```

所有 API 使用统一响应：

```json
{
  "success": true,
  "message": "ok",
  "data": {}
}
```

失败响应：

```json
{
  "success": false,
  "message": "错误说明",
  "data": null
}
```

## 修改自选基金

编辑 `src/config.ts`：

```ts
export const FUND_LIST = [
  { code: "000001", name: "示例基金", category: "混合型" },
  { code: "000002", name: "示例指数基金", category: "指数型" },
];
```

分类完全由配置决定，前端按钮自动生成。基金代码必须是六位数字。

## 更换第三方接口

第三方原始字段只存在于：

```text
src/providers/fundProvider.ts
src/providers/providerTypes.ts
```

更换供应商时，修改 URL、请求和字段映射，仍输出 `src/types.ts` 中的 `FundEstimate`。前端和 API 不需要理解供应商字段。

## 类型检查与构建验证

```bash
npm run types
npm run typecheck
npm run check
```

## 部署到 Cloudflare

```bash
npm run deploy
```

部署完成后 Wrangler 会输出 `workers.dev` 地址。首次新增或修改 Cron Trigger 最多可能需要约 15 分钟传播。

## 查看日志

```bash
npx wrangler tail
```

日志包含更新开始、基金总数、成功/失败数量、第三方耗时、KV 写入和旧缓存使用情况，不会记录刷新密钥、Cookie 或敏感请求头。

## 常见错误排查

### `REFRESH_TOKEN` 未配置

运行：

```bash
npx wrangler secret put REFRESH_TOKEN
```

### KV 绑定不存在

确认 `wrangler.jsonc` 中绑定名为 `FUND_CACHE`。无绑定时 Worker 仍能运行，但页面访问会直接查询 Provider，且无法缓存。

### 第三方接口不可用或返回 HTML

查看 `npx wrangler tail`。单只失败会显示 `--`，不会让整个接口失败。可将 `USE_MOCK_DATA` 改为 `true` 验证页面和部署。

### 页面仍显示旧数据

普通访问会优先使用 300 秒内的 KV 快照。需要立即更新时使用带 Secret 的强制刷新接口。

### Cron 没有更新

Cron 只在北京时间周一至周五的交易时段请求 Provider，不处理法定节假日和调休。新增 Trigger 后也可能需要等待传播。

### 类型生成不同步

修改 `wrangler.jsonc` 后运行：

```bash
npm run types
npm run typecheck
```

## 免费额度注意事项

本项目按个人低频使用设计：静态资源优先由 Workers Static Assets 直接提供，API 才进入 Worker；第三方并发限制为 5，低于免费版同时外连限制。请关注 Cloudflare 当前免费额度、KV 写入额度和 Cron Trigger 数量。额度与规则可能调整，部署前以 Cloudflare 官方文档为准。
