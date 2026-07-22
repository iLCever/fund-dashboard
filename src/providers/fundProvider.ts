import type { FundConfig, FundEstimate } from "../types";
import type { FundProviderOptions, FundThemeAnalysis, ProviderBatchResult } from "./providerTypes";

export const DEFAULT_FUND_API_URL = "https://hq.sinajs.cn/list={symbols}";
export const DEFAULT_FUND_API_TIMEOUT = 8_000;
export const DEFAULT_MAX_CONCURRENCY = 5;

const DATA_SOURCE = "新浪财经基金行情";
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_HOLDINGS_RESPONSE_BYTES = 256 * 1_024;
const MAX_BATCH_SIZE = 50;
const SINA_LINE_PATTERN = /var\s+hq_str_fu_(\d{6})="([^"]*)";/g;
const HOLDINGS_API_URL = "https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code={code}&topline=10&year=&month=";
const STOCK_PROFILE_API_URL = "https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax";

interface HoldingProfile {
  code: string;
  name: string;
  industry: string;
  concepts: string;
}

const THEME_RULES: Array<{ theme: string; pattern: RegExp; multiplier: number }> = [
  { theme: "CPO/光通信", pattern: /CPO|光模块|光通信|光纤|光缆|通信设备|中际旭创|新易盛|天孚通信|光迅科技|源杰科技|剑桥科技|亨通光电|长飞光纤/, multiplier: 2.1 },
  { theme: "PCB", pattern: /PCB|印制电路|电路板|覆铜板|沪电股份|深南电路|胜宏科技|生益科技|东山精密|南亚新材|华正新材|鼎泰高科|大族数控|景旺电子|宏和科技/, multiplier: 2 },
  { theme: "半导体设备", pattern: /半导体设备|光刻|刻蚀|薄膜沉积|晶圆制造设备|清洗设备|检测设备|中科飞测|芯源微|中微公司|华海清科|北方华创|精测电子|富创精密|拓荆科技|盛美上海/, multiplier: 2 },
  { theme: "锂电设备", pattern: /锂电.*设备|电池制造设备|利元亨|海目星|先导智能|杭可科技|先惠技术|宏工科技|赢合科技/, multiplier: 1.9 },
  { theme: "固态电池", pattern: /固态电池|固体电池/, multiplier: 1.8 },
  { theme: "半导体", pattern: /半导体|芯片|集成电路|先进封装|寒武纪|海光信息/, multiplier: 1.55 },
  { theme: "机器人", pattern: /机器人|减速器|机器视觉/, multiplier: 1.45 },
  { theme: "消费电子", pattern: /消费电子|苹果概念|智能穿戴/, multiplier: 1.35 },
  { theme: "新能源车", pattern: /新能源汽车|新能源车|智能汽车|汽车零部件/, multiplier: 1.3 },
  { theme: "锂电池", pattern: /锂电池|电池|锂矿|正极材料|负极材料/, multiplier: 1.25 },
  { theme: "光伏", pattern: /光伏|太阳能/, multiplier: 1.35 },
  { theme: "储能", pattern: /储能/, multiplier: 1.35 },
  { theme: "创新药", pattern: /创新药|生物制品|化学制药|医药商业|百济神州|恒瑞医药|荣昌生物|迪哲医药|康方生物/, multiplier: 1.4 },
  { theme: "医疗器械", pattern: /医疗器械|医疗服务/, multiplier: 1.3 },
  { theme: "军工", pattern: /军工|国防|航空航天|航天装备|航空装备/, multiplier: 1.3 },
  { theme: "白酒", pattern: /白酒|酿酒/, multiplier: 1.35 },
  { theme: "食品饮料", pattern: /食品饮料|食品加工|饮料乳品/, multiplier: 1.25 },
  { theme: "家电", pattern: /家电|白色家电|黑色家电|厨卫电器|小家电/, multiplier: 1.2 },
  { theme: "证券", pattern: /证券|券商/, multiplier: 1.25 },
  { theme: "银行", pattern: /银行/, multiplier: 1.25 },
  { theme: "有色金属", pattern: /有色|稀土|贵金属|工业金属|小金属/, multiplier: 1.2 },
  { theme: "煤炭", pattern: /煤炭/, multiplier: 1.2 },
  { theme: "通信", pattern: /通信|5G/, multiplier: 1.15 },
  { theme: "软件", pattern: /软件|计算机应用|互联网服务/, multiplier: 1.15 },
  { theme: "电子元件", pattern: /电子元件|元件|电子化学品/, multiplier: 1.1 },
];

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

async function readLimitedBytes(response: Response, maximumBytes = MAX_RESPONSE_BYTES): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
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
    if (total > maximumBytes) {
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

async function readLimitedText(response: Response, maximumBytes = MAX_RESPONSE_BYTES): Promise<string> {
  return new TextDecoder().decode(await readLimitedBytes(response, maximumBytes));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseHoldingPage(text: string): { secids: string[]; reportDate: string | null } {
  if (text.trimStart().startsWith("<")) throw new Error("持仓接口返回 HTML 错误页");
  const secids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/quote\.eastmoney\.com\/unify\/r\/(\d+\.\d{6})/g)) {
    const secid = match[1];
    if (!secid || seen.has(secid)) continue;
    seen.add(secid);
    secids.push(secid);
    if (secids.length >= 10) break;
  }
  const reportDate = /截止至：<font[^>]*>(\d{4}-\d{2}-\d{2})<\/font>/.exec(text)?.[1] ?? null;
  if (!secids.length) throw new Error("暂无公开股票持仓");
  return { secids, reportDate };
}

async function fetchHoldingProfile(secid: string, timeoutMs: number): Promise<HoldingProfile | null> {
  try {
    const [market, stockCode] = secid.split(".");
    if (!stockCode || (market !== "0" && market !== "1")) return null;
    const exchangeCode = `${market === "1" ? "SH" : "SZ"}${stockCode}`;
    const url = new URL(STOCK_PROFILE_API_URL);
    url.searchParams.set("code", exchangeCode);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        referer: `https://emweb.securities.eastmoney.com/PC_HSF10/pages/index.html?type=web&code=${exchangeCode}`,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const parsed: unknown = JSON.parse(await readLimitedText(response));
    if (!isRecord(parsed) || !Array.isArray(parsed.ssbk)) return null;
    const boards = parsed.ssbk.filter(isRecord);
    const boardNames = boards
      .map((board) => typeof board.BOARD_NAME === "string" ? board.BOARD_NAME : "")
      .filter(Boolean);
    const firstBoard = boards[0];
    return {
      code: stockCode,
      name: firstBoard && typeof firstBoard.SECURITY_NAME_ABBR === "string" ? firstBoard.SECURITY_NAME_ABBR : stockCode,
      industry: boardNames.slice(0, 3).join(" "),
      concepts: boardNames.join(" "),
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
    for (const rule of THEME_RULES) {
      let score = 0;
      if (rule.pattern.test(profile.industry)) score += rankWeight * 3;
      if (rule.pattern.test(profile.name)) score += rankWeight * 2;
      if (rule.pattern.test(profile.concepts)) score += rankWeight;
      if (score === 0) continue;
      score *= rule.multiplier;
      scores.set(rule.theme, (scores.get(rule.theme) ?? 0) + score);
      hitCounts.set(rule.theme, (hitCounts.get(rule.theme) ?? 0) + 1);
    }
  });
  const winner = [...scores.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  const theme = winner && (hitCounts.get(winner) ?? 0) >= 2 ? winner : "多行业均衡";
  return {
    theme,
    basis: profiles.slice(0, 5).map((profile) => `${profile.name}${profile.industry ? `（${profile.industry}）` : ""}`),
  };
}

export async function fetchFundThemeFromHoldings(
  code: string,
  timeoutMs = DEFAULT_FUND_API_TIMEOUT,
): Promise<FundThemeAnalysis> {
  if (!/^\d{6}$/.test(code)) throw new Error("基金代码格式错误");
  const response = await fetch(HOLDINGS_API_URL.replace("{code}", encodeURIComponent(code)), {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: "application/javascript, text/plain;q=0.9",
      referer: `https://fund.eastmoney.com/${code}.html`,
    },
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
