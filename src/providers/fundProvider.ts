import type { FundConfig, FundEstimate } from "../types";
import type { EastmoneyFundEstimateResponse, EastmoneyOfficialNavResponse, FundProviderOptions, FundThemeAnalysis, OfficialNavRecord, ProviderBatchResult } from "./providerTypes";

export const DEFAULT_FUND_API_URL = "https://fundgz.1234567.com.cn/js/{code}.js";
export const DEFAULT_FUND_API_TIMEOUT = 8_000;
export const DEFAULT_MAX_CONCURRENCY = 5;

const MAX_RESPONSE_BYTES = 64 * 1_024;
const MAX_HOLDINGS_RESPONSE_BYTES = 256 * 1_024;
const HOLDINGS_API_URL = "https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code={code}&topline=10&year=&month=";
const STOCK_PROFILE_API_URL = "https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax";
const OFFICIAL_NAV_API_URL = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo";

function failedEstimate(fund: FundConfig, message: string, source = "天天基金估值接口"): FundEstimate {
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
    source,
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
    navDate: now.toISOString().slice(0, 10),
    estimateTime: now.toISOString(),
    source: "模拟数据",
    status: "success",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nullableNumber(value: unknown, field: string): number {
  if (value === null || value === undefined || value === "") throw new Error(`${field} 为空`);
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} 不是有效数字`);
  return number;
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeEstimateTime(value: unknown): string {
  if (typeof value !== "string") throw new Error("估值时间无效");
  const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) throw new Error("估值时间无效");
  const [, date, time, seconds = "00"] = match;
  const parsed = new Date(`${date}T${time}:${seconds}+08:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error("估值时间无效");
  return parsed.toISOString();
}

function extractJsonp(text: string): EastmoneyFundEstimateResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) throw new Error("第三方接口返回了 HTML");
  const prefix = "jsonpgz(";
  const suffixLength = trimmed.endsWith(");") ? 2 : trimmed.endsWith(")") ? 1 : 0;
  if (!trimmed.startsWith(prefix) || suffixLength === 0) throw new Error("第三方接口格式发生变化");

  const parsed: unknown = JSON.parse(trimmed.slice(prefix.length, -suffixLength));
  if (!isRecord(parsed)) throw new Error("第三方接口返回空数据");
  return parsed;
}

async function readLimitedText(response: Response, maximumBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error("第三方响应过大");
  if (!response.body) throw new Error("第三方接口返回空数据");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("response too large");
      throw new Error("第三方响应过大");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(combined);
  if (!text.trim()) throw new Error("第三方接口返回空数据");
  return text;
}

export async function fetchLatestOfficialNavs(
  codes: readonly string[],
  timeoutMs = DEFAULT_FUND_API_TIMEOUT,
): Promise<OfficialNavRecord[]> {
  const uniqueCodes = [...new Set(codes)];
  if (!uniqueCodes.length) return [];
  if (uniqueCodes.length > 30 || uniqueCodes.some((code) => !/^\d{6}$/.test(code))) {
    throw new Error("正式净值基金代码无效");
  }

  const url = new URL(OFFICIAL_NAV_API_URL);
  url.searchParams.set("FCODES", uniqueCodes.join(","));
  url.searchParams.set("deviceid", "Wap");
  url.searchParams.set("plat", "Wap");
  url.searchParams.set("product", "EFund");
  url.searchParams.set("version", "6.4.7");
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      referer: "https://fund.eastmoney.com/",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 429) {
    await response.body?.cancel();
    throw new Error("正式净值接口限流");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`正式净值接口 HTTP ${response.status}`);
  }

  const parsed: unknown = JSON.parse(await readLimitedText(response));
  if (!isRecord(parsed)) throw new Error("正式净值接口返回空数据");
  const raw = parsed as EastmoneyOfficialNavResponse;
  if (raw.Success !== true || !Array.isArray(raw.Datas)) throw new Error("正式净值接口格式发生变化");

  const requestedCodes = new Set(uniqueCodes);
  const records: OfficialNavRecord[] = [];
  for (const item of raw.Datas) {
    if (!isRecord(item)) continue;
    const code = typeof item.FCODE === "string" ? item.FCODE.trim() : "";
    const navDate = typeof item.PDATE === "string" ? item.PDATE.trim().slice(0, 10) : "";
    if (!requestedCodes.has(code) || !/^\d{4}-\d{2}-\d{2}$/.test(navDate)) continue;
    try {
      const name = typeof item.SHORTNAME === "string" ? item.SHORTNAME.trim() : "";
      records.push({
        code,
        name: name || code,
        officialNav: nullableNumber(item.NAV, "正式净值"),
        officialChangePct: optionalNumber(item.NAVCHGRT),
        navDate,
      });
    } catch {
      continue;
    }
  }
  if (!records.length) throw new Error("正式净值接口没有有效数据");
  return records;
}

interface HoldingProfile {
  code: string;
  name: string;
  industry: string;
  concepts: string;
}

const THEME_RULES: Array<{ theme: string; pattern: RegExp; multiplier: number }> = [
  { theme: "PCB", pattern: /PCB|印制电路|电路板|覆铜板/, multiplier: 1.6 },
  { theme: "固态电池", pattern: /固态电池|固体电池/, multiplier: 1.6 },
  { theme: "半导体", pattern: /半导体|芯片|集成电路|光刻机|先进封装/, multiplier: 1.45 },
  { theme: "AI算力", pattern: /人工智能|AI算力|算力|数据中心|CPO|光模块/, multiplier: 1.4 },
  { theme: "机器人", pattern: /机器人|减速器|机器视觉/, multiplier: 1.4 },
  { theme: "消费电子", pattern: /消费电子|苹果概念|智能穿戴/, multiplier: 1.3 },
  { theme: "新能源车", pattern: /新能源汽车|新能源车|智能汽车|汽车零部件/, multiplier: 1.25 },
  { theme: "锂电池", pattern: /锂电池|电池|锂矿|正极材料|负极材料/, multiplier: 1.2 },
  { theme: "光伏", pattern: /光伏|太阳能/, multiplier: 1.3 },
  { theme: "储能", pattern: /储能/, multiplier: 1.3 },
  { theme: "创新药", pattern: /创新药|生物制品|化学制药|医药商业/, multiplier: 1.25 },
  { theme: "医疗器械", pattern: /医疗器械|医疗服务/, multiplier: 1.25 },
  { theme: "军工", pattern: /军工|国防|航空航天|航天装备|航空装备/, multiplier: 1.25 },
  { theme: "白酒", pattern: /白酒|酿酒/, multiplier: 1.3 },
  { theme: "食品饮料", pattern: /食品饮料|食品加工|饮料乳品/, multiplier: 1.2 },
  { theme: "家电", pattern: /家电|白色家电|黑色家电|厨卫电器|小家电/, multiplier: 1.15 },
  { theme: "证券", pattern: /证券|券商/, multiplier: 1.2 },
  { theme: "银行", pattern: /银行/, multiplier: 1.2 },
  { theme: "有色金属", pattern: /有色|稀土|贵金属|工业金属|小金属/, multiplier: 1.15 },
  { theme: "煤炭", pattern: /煤炭/, multiplier: 1.15 },
  { theme: "通信", pattern: /通信|5G/, multiplier: 1.1 },
  { theme: "软件", pattern: /软件|计算机应用|互联网服务/, multiplier: 1.1 },
  { theme: "电子元件", pattern: /电子元件|元件|电子化学品/, multiplier: 1.05 },
];

function parseHoldingPage(text: string): { secids: string[]; reportDate: string | null } {
  if (text.trim().startsWith("<")) throw new Error("持仓接口返回 HTML 错误页");
  const secids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/quote\.eastmoney\.com\/unify\/r\/(\d+\.\d{6})/g)) {
    const secid = match[1];
    if (!secid || seen.has(secid)) continue;
    seen.add(secid);
    secids.push(secid);
    if (secids.length >= 8) break;
  }
  const reportDate = /截止至：<font[^>]*>(\d{4}-\d{2}-\d{2})<\/font>/.exec(text)?.[1] ?? null;
  if (!secids.length) throw new Error("暂无公开股票持仓");
  return { secids, reportDate };
}

async function fetchHoldingProfile(secid: string, timeoutMs: number): Promise<HoldingProfile | null> {
  try {
    const url = new URL(STOCK_PROFILE_API_URL);
    const [market, stockCode] = secid.split(".");
    if (!stockCode || (market !== "0" && market !== "1")) return null;
    url.searchParams.set("code", `${market === "1" ? "SH" : "SZ"}${stockCode}`);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json", referer: `https://emweb.securities.eastmoney.com/PC_HSF10/pages/index.html?type=web&code=${market === "1" ? "SH" : "SZ"}${stockCode}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const parsed: unknown = JSON.parse(await readLimitedText(response));
    if (!isRecord(parsed) || !Array.isArray(parsed.ssbk)) return null;
    const boards = parsed.ssbk.filter(isRecord);
    const boardNames = boards.map((board) => typeof board.BOARD_NAME === "string" ? board.BOARD_NAME : "").filter(Boolean);
    const firstBoard = boards[0];
    return {
      code: stockCode,
      name: firstBoard && typeof firstBoard.SECURITY_NAME_ABBR === "string" ? firstBoard.SECURITY_NAME_ABBR : "",
      industry: boardNames.slice(0, 3).join(","),
      concepts: boardNames.join(","),
    };
  } catch {
    return null;
  }
}

function analyzeHoldingTheme(profiles: HoldingProfile[]): { theme: string; basis: string[] } {
  const scores = new Map<string, number>();
  const hitCounts = new Map<string, number>();
  profiles.forEach((profile, index) => {
    const rankWeight = Math.max(1, profiles.length - index);
    THEME_RULES.forEach((rule) => {
      let score = 0;
      if (rule.pattern.test(profile.industry)) score += rankWeight * 3;
      if (rule.pattern.test(profile.name)) score += rankWeight * 2;
      if (rule.pattern.test(profile.concepts)) score += rankWeight;
      if (score > 0) {
        scores.set(rule.theme, (scores.get(rule.theme) ?? 0) + score * rule.multiplier);
        hitCounts.set(rule.theme, (hitCounts.get(rule.theme) ?? 0) + 1);
      }
    });
  });
  const winner = [...scores.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  const theme = winner && (hitCounts.get(winner) ?? 0) >= 2 ? winner : "多行业均衡";
  return {
    theme,
    basis: profiles.slice(0, 5).map((profile) => `${profile.name}${profile.industry ? `（${profile.industry}）` : ""}`),
  };
}

export async function fetchFundThemeFromHoldings(code: string, timeoutMs = DEFAULT_FUND_API_TIMEOUT): Promise<FundThemeAnalysis> {
  if (!/^\d{6}$/.test(code)) throw new Error("基金代码格式错误");
  const holdingsUrl = HOLDINGS_API_URL.replace("{code}", encodeURIComponent(code));
  const response = await fetch(holdingsUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/javascript, text/plain;q=0.9", referer: `https://fund.eastmoney.com/${code}.html` },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`持仓接口 HTTP ${response.status}`);
  }
  const { secids, reportDate } = parseHoldingPage(await readLimitedText(response, MAX_HOLDINGS_RESPONSE_BYTES));
  const profiles: HoldingProfile[] = [];
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < secids.length) {
      const index = nextIndex;
      nextIndex += 1;
      const secid = secids[index];
      if (!secid) continue;
      const profile = await fetchHoldingProfile(secid, timeoutMs);
      if (profile) profiles[index] = profile;
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, secids.length) }, () => worker()));
  const validProfiles = profiles.filter((profile): profile is HoldingProfile => Boolean(profile));
  if (!validProfiles.length) throw new Error("持仓行业数据获取失败");
  const analysis = analyzeHoldingTheme(validProfiles);
  return {
    code,
    theme: analysis.theme,
    reportDate,
    holdingsCount: validProfiles.length,
    basis: analysis.basis,
    analyzedAt: new Date().toISOString(),
  };
}

function requestUrl(template: string, code: string): string {
  const encodedCode = encodeURIComponent(code);
  return template.includes("{code}")
    ? template.replaceAll("{code}", encodedCode)
    : `${template.replace(/\/$/, "")}/${encodedCode}.js`;
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
    const response = await fetch(requestUrl(options.apiUrl, fund.code), {
      headers: {
        accept: "application/javascript, text/plain;q=0.9",
        referer: "https://fund.eastmoney.com/",
      },
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (response.status === 429) {
      await response.body?.cancel();
      throw new Error("第三方接口限流");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`第三方接口 HTTP ${response.status}`);
    }

    const raw = extractJsonp(await readLimitedText(response));
    if (raw.fundcode !== fund.code) throw new Error("第三方基金代码不匹配");

    return {
      code: fund.code,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : fund.name,
      category: fund.category,
      estimatedNav: nullableNumber(raw.gsz, "估算净值"),
      estimatedChangePct: nullableNumber(raw.gszzl, "估算涨幅"),
      previousNav: nullableNumber(raw.dwjz, "上一交易日净值"),
      officialNav: null,
      officialChangePct: null,
      navDate: typeof raw.jzrq === "string" && raw.jzrq.trim() ? raw.jzrq.trim() : null,
      estimateTime: normalizeEstimateTime(raw.gztime),
      source: "天天基金估值接口",
      status: "success",
    };
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
    const message = isTimeout ? `请求超时（${options.timeoutMs}毫秒）` : error instanceof Error ? error.message : "数据获取失败";
    console.warn(JSON.stringify({ event: "fund_provider_failed", fundCode: fund.code, error: message }));
    return failedEstimate(fund, message);
  }
}

export async function fetchFundEstimates(
  funds: readonly FundConfig[],
  options: FundProviderOptions,
): Promise<ProviderBatchResult> {
  const startedAt = Date.now();
  const results: FundEstimate[] = new Array(funds.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < funds.length) {
      const index = nextIndex;
      nextIndex += 1;
      const fund = funds[index];
      if (!fund) continue;
      results[index] = await fetchFundEstimate(fund, options);
    }
  }

  const concurrency = Math.min(Math.max(1, options.maxConcurrency), funds.length || 1);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    funds: results,
    dataSource: options.useMockData ? "模拟数据" : "天天基金估值接口",
    durationMs: Date.now() - startedAt,
  };
}
