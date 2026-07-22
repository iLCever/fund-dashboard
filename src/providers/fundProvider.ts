import type { FundConfig, FundEstimate } from "../types";
import type { FundProviderOptions, ProviderBatchResult } from "./providerTypes";

export const DEFAULT_FUND_API_URL = "https://hq.sinajs.cn/list={symbols}";
export const DEFAULT_FUND_API_TIMEOUT = 8_000;
export const DEFAULT_MAX_CONCURRENCY = 5;

const DATA_SOURCE = "新浪财经基金行情";
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_BATCH_SIZE = 50;
const SINA_LINE_PATTERN = /var\s+hq_str_fu_(\d{6})="([^"]*)";/g;

function failedEstimate(fund: FundConfig, message: string): FundEstimate {
  return {
    code: fund.code,
    name: fund.name,
    category: fund.category,
    estimatedNav: null,
    estimatedChangePct: null,
    previousNav: null,
    officialNav: null,
    officialChangePct: null,
    navDate: null,
    estimateTime: null,
    source: DATA_SOURCE,
    status: "failed",
    error: message,
  };
}

function codeSeed(code: string): number {
  return [...code].reduce((total, character) => total + character.charCodeAt(0), 0);
}

function mockEstimate(fund: FundConfig, now: Date): FundEstimate {
  const seed = codeSeed(fund.code);
  const previousNav = 0.8 + (seed % 1800) / 1_000;
  const minute = Math.floor(now.getTime() / 60_000);
  const estimatedChangePct = Math.round(Math.sin(minute * 0.23 + seed) * 185) / 100;
  const estimatedNav = Math.round(previousNav * (1 + estimatedChangePct / 100) * 10_000) / 10_000;

  return {
    code: fund.code,
    name: fund.name,
    category: fund.category,
    estimatedNav,
    estimatedChangePct,
    previousNav: Math.round(previousNav * 10_000) / 10_000,
    officialNav: null,
    officialChangePct: null,
    navDate: null,
    estimateTime: now.toISOString(),
    source: "模拟数据",
    status: "success",
  };
}

function finiteNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function beijingDateKey(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function normalizeEstimateTime(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}:\d{2}$/.test(time)) return null;
  const parsed = new Date(`${date}T${time}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function buildRequestUrl(template: string, funds: readonly FundConfig[]): string {
  const symbols = funds.map((fund) => `fu_${fund.code}`).join(",");
  return template.includes("{symbols}")
    ? template.replaceAll("{symbols}", symbols)
    : `${template}${template.includes("?") ? "&" : "?"}list=${symbols}`;
}

async function readLimitedBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("新浪响应数据过大");
  }
  if (!response.body) throw new Error("新浪接口返回空数据");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel("response too large");
      throw new Error("新浪响应数据过大");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (combined.byteLength === 0) throw new Error("新浪接口返回空数据");
  return combined;
}

function parseSinaResponse(text: string, funds: readonly FundConfig[], now: Date): FundEstimate[] {
  if (text.trimStart().startsWith("<")) throw new Error("新浪接口返回了 HTML");
  const configs = new Map(funds.map((fund) => [fund.code, fund]));
  const estimates = new Map<string, FundEstimate>();

  for (const match of text.matchAll(SINA_LINE_PATTERN)) {
    const code = match[1];
    const payload = match[2];
    if (!code || payload === undefined || !configs.has(code) || !payload.trim()) continue;

    const fund = configs.get(code);
    if (!fund) continue;
    const fields = payload.split(",");
    if (fields.length < 8) {
      estimates.set(code, failedEstimate(fund, "新浪接口字段不足"));
      continue;
    }

    const name = fields[0]?.trim() || fund.name || code;
    const estimatedNav = finiteNumber(fields[2]);
    const previousNav = finiteNumber(fields[3]);
    const estimatedChangePct = finiteNumber(fields[6]);
    const quoteDate = fields[7]?.trim() ?? "";
    const estimateTime = normalizeEstimateTime(quoteDate, fields[1]?.trim() ?? "");
    if (estimatedNav === null || estimatedChangePct === null || estimateTime === null) {
      estimates.set(code, failedEstimate({ ...fund, name }, "新浪暂未提供有效盘中估算"));
      continue;
    }

    const stale = quoteDate !== beijingDateKey(now);
    estimates.set(code, {
      code,
      name,
      category: fund.category,
      estimatedNav,
      estimatedChangePct,
      previousNav,
      officialNav: previousNav,
      officialChangePct: null,
      navDate: null,
      estimateTime,
      source: DATA_SOURCE,
      status: stale ? "stale" : "success",
      ...(stale ? { error: `新浪最新估值日期为 ${quoteDate}` } : {}),
    });
  }

  return funds.map((fund) => estimates.get(fund.code) ?? failedEstimate(fund, "新浪未返回该基金数据"));
}

async function fetchSinaBatch(funds: readonly FundConfig[], options: FundProviderOptions): Promise<FundEstimate[]> {
  if (!funds.length) return [];
  if (funds.length > MAX_BATCH_SIZE) throw new Error(`单次最多查询 ${MAX_BATCH_SIZE} 只基金`);
  if (funds.some((fund) => !/^\d{6}$/.test(fund.code))) throw new Error("基金代码格式错误");

  const response = await fetch(buildRequestUrl(options.apiUrl, funds), {
    headers: {
      accept: "text/plain, application/javascript;q=0.9",
      referer: "https://finance.sina.com.cn/",
    },
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  if (response.status === 429) {
    await response.body?.cancel();
    throw new Error("新浪接口限流");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`新浪接口 HTTP ${response.status}`);
  }

  const bytes = await readLimitedBytes(response);
  const text = new TextDecoder("gbk").decode(bytes);
  return parseSinaResponse(text, funds, options.now);
}

const DEFAULT_OPTIONS: FundProviderOptions = {
  apiUrl: DEFAULT_FUND_API_URL,
  timeoutMs: DEFAULT_FUND_API_TIMEOUT,
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
  useMockData: true,
  now: new Date(0),
};

export async function fetchFundEstimate(
  fund: FundConfig,
  options: FundProviderOptions = { ...DEFAULT_OPTIONS, now: new Date() },
): Promise<FundEstimate> {
  if (!/^\d{6}$/.test(fund.code)) return failedEstimate(fund, "基金代码格式错误");
  if (options.useMockData) return mockEstimate(fund, options.now);
  try {
    return (await fetchSinaBatch([fund], options))[0] ?? failedEstimate(fund, "新浪未返回该基金数据");
  } catch (error) {
    const message = error instanceof Error ? error.message : "新浪数据获取失败";
    console.warn(JSON.stringify({ event: "sina_fund_failed", fundCode: fund.code, error: message }));
    return failedEstimate(fund, message);
  }
}

export async function fetchFundEstimates(
  funds: readonly FundConfig[],
  options: FundProviderOptions,
): Promise<ProviderBatchResult> {
  const startedAt = Date.now();
  let results: FundEstimate[];
  if (options.useMockData) {
    results = funds.map((fund) => /^\d{6}$/.test(fund.code) ? mockEstimate(fund, options.now) : failedEstimate(fund, "基金代码格式错误"));
  } else {
    try {
      results = await fetchSinaBatch(funds, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : "新浪数据获取失败";
      console.warn(JSON.stringify({ event: "sina_batch_failed", fundCount: funds.length, error: message }));
      results = funds.map((fund) => failedEstimate(fund, message));
    }
  }

  return {
    funds: results,
    dataSource: options.useMockData ? "模拟数据" : DATA_SOURCE,
    durationMs: Date.now() - startedAt,
  };
}
