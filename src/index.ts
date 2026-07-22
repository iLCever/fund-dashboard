import { FUND_LIST } from "./config";
import { DEFAULT_FUND_API_TIMEOUT, DEFAULT_FUND_API_URL, DEFAULT_MAX_CONCURRENCY, fetchFundEstimates, fetchFundThemeFromHoldings, fetchLatestOfficialNavs } from "./providers/fundProvider";
import type { FundProviderOptions, FundThemeAnalysis, OfficialNavRecord } from "./providers/providerTypes";
import type { ApiResponse, FundEstimate, FundSnapshot, HealthData } from "./types";
import {
  FUND_CACHE_KEY,
  FUND_REFRESH_LOCK_KEY,
  REFRESH_LOCK_TTL_SECONDS,
  STALE_CACHE_TTL_SECONDS,
  createSnapshot,
  filterSnapshot,
  isBeijingTradingSession,
  isFreshSnapshot,
  isFundSnapshot,
  markSnapshotStale,
  parseBoolean,
  parseInteger,
  secureTokenEqual,
  sortFunds,
  toBeijingIso,
} from "./utils";

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

type CacheStatus = "HIT" | "MISS" | "STALE" | "BYPASS" | "REFRESH" | "ERROR";

interface SnapshotResult {
  snapshot: FundSnapshot;
  cacheStatus: CacheStatus;
}

const THEME_CACHE_PREFIX = "fund_theme_v3:";
const THEME_FRESH_SECONDS = 30 * 24 * 60 * 60;
const THEME_STORAGE_SECONDS = 60 * 24 * 60 * 60;
const OFFICIAL_NAV_CACHE_PREFIX = "fund_official_nav_v1:";
const OFFICIAL_NAV_EVENING_FRESH_SECONDS = 5 * 60;
const OFFICIAL_NAV_DAYTIME_FRESH_SECONDS = 60 * 60;
const OFFICIAL_NAV_TODAY_FRESH_SECONDS = 12 * 60 * 60;
const OFFICIAL_NAV_STORAGE_SECONDS = 2 * 24 * 60 * 60;

interface OfficialNavBatchCache {
  checkedAt: string;
  funds: OfficialNavRecord[];
}

function categoryOrder(): string[] {
  return [...new Set(FUND_LIST.map((fund) => fund.category))];
}

function jsonResponse<T>(body: ApiResponse<T>, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({
    ...SECURITY_HEADERS,
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  return Response.json(body, { status, headers });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ success: false, message, data: null }, status);
}

function providerOptions(env: Env, now: Date): FundProviderOptions {
  return {
    apiUrl: env.FUND_API_URL || DEFAULT_FUND_API_URL,
    timeoutMs: parseInteger(env.FUND_API_TIMEOUT, DEFAULT_FUND_API_TIMEOUT, 1_000, 30_000),
    maxConcurrency: parseInteger(env.MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY, 1, 5),
    useMockData: parseBoolean(env.USE_MOCK_DATA, true),
    now,
  };
}

function cacheBinding(env: Env): KVNamespace | undefined {
  return env.FUND_CACHE as KVNamespace | undefined;
}

async function readCachedSnapshot(cache: KVNamespace | undefined): Promise<FundSnapshot | null> {
  if (!cache) return null;
  try {
    const value: unknown = await cache.get(FUND_CACHE_KEY, "json");
    if (value === null) return null;
    if (!isFundSnapshot(value)) {
      console.warn(JSON.stringify({ event: "cache_invalid", key: FUND_CACHE_KEY }));
      return null;
    }
    const configuredCodes = new Set(FUND_LIST.map((fund) => fund.code));
    if (value.funds.length !== FUND_LIST.length || value.funds.some((fund) => !configuredCodes.has(fund.code))) {
      console.log(JSON.stringify({ event: "cache_config_changed", key: FUND_CACHE_KEY }));
      return null;
    }
    return value;
  } catch (error) {
    console.warn(JSON.stringify({ event: "cache_read_failed", error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

function mergeFailedFunds(current: FundEstimate[], previous: FundSnapshot | null): FundEstimate[] {
  if (!previous) return current;
  const previousByCode = new Map(previous.funds.map((fund) => [fund.code, fund]));
  return current.map((fund) => {
    if (fund.status !== "failed") return fund;
    const old = previousByCode.get(fund.code);
    if (!old || old.estimatedNav === null) return fund;
    return {
      ...old,
      category: fund.category,
      status: "stale",
      error: fund.error ?? "本次更新失败，使用缓存数据",
    };
  });
}

async function buildFreshSnapshot(env: Env, now: Date): Promise<FundSnapshot> {
  console.log(JSON.stringify({ event: "fund_refresh_started", total: FUND_LIST.length, useMockData: parseBoolean(env.USE_MOCK_DATA, true) }));
  const options = providerOptions(env, now);
  const startedAt = Date.now();
  const batch = options.useMockData
    ? await fetchFundEstimates(FUND_LIST, options)
    : { funds: FUND_LIST.map(officialNavPlaceholder), dataSource: "天天基金正式净值接口", durationMs: 0 };
  const resolvedFunds = options.useMockData ? batch.funds : await enrichWithOfficialNav(batch.funds, env);
  const funds = sortFunds(resolvedFunds, categoryOrder());
  const snapshot = createSnapshot(funds, batch.dataSource, toBeijingIso(now.getTime()));
  console.log(JSON.stringify({
    event: "fund_refresh_completed",
    total: snapshot.total,
    successCount: snapshot.successCount,
    failedCount: snapshot.failedCount,
    providerDurationMs: Date.now() - startedAt,
  }));
  return snapshot;
}

async function refreshSnapshot(env: Env, reason: "request" | "forced" | "cron", previous?: FundSnapshot | null): Promise<SnapshotResult> {
  const cache = cacheBinding(env);
  const oldSnapshot = previous === undefined ? await readCachedSnapshot(cache) : previous;
  if (!cache) return { snapshot: await buildFreshSnapshot(env, new Date()), cacheStatus: "BYPASS" };

  if (reason !== "forced") {
    try {
      const locked = await cache.get(FUND_REFRESH_LOCK_KEY);
      if (locked !== null) {
        console.log(JSON.stringify({ event: "fund_refresh_lock_active", reason }));
        if (oldSnapshot) return { snapshot: markSnapshotStale(oldSnapshot), cacheStatus: "STALE" };
        return { snapshot: await buildFreshSnapshot(env, new Date()), cacheStatus: "MISS" };
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "refresh_lock_read_failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }

  try {
    await cache.put(FUND_REFRESH_LOCK_KEY, crypto.randomUUID(), { expirationTtl: REFRESH_LOCK_TTL_SECONDS });
    const now = reason === "cron" ? new Date() : new Date();
    const fresh = await buildFreshSnapshot(env, now);

    if (fresh.successCount === 0 && oldSnapshot) {
      console.warn(JSON.stringify({ event: "fund_refresh_all_failed_using_stale", reason }));
      return { snapshot: markSnapshotStale(oldSnapshot), cacheStatus: "STALE" };
    }

    const mergedFunds = mergeFailedFunds(fresh.funds, oldSnapshot);
    const merged = createSnapshot(sortFunds(mergedFunds, categoryOrder()), fresh.dataSource, fresh.updatedAt);
    if (merged.successCount > 0) {
      await cache.put(FUND_CACHE_KEY, JSON.stringify(merged), { expirationTtl: STALE_CACHE_TTL_SECONDS });
      console.log(JSON.stringify({ event: "kv_snapshot_written", reason, successCount: merged.successCount, failedCount: merged.failedCount }));
    }
    return { snapshot: merged, cacheStatus: reason === "forced" ? "REFRESH" : "MISS" };
  } catch (error) {
    console.error(JSON.stringify({ event: "fund_refresh_failed", reason, error: error instanceof Error ? error.message : String(error) }));
    if (oldSnapshot) return { snapshot: markSnapshotStale(oldSnapshot), cacheStatus: "STALE" };
    return { snapshot: await buildFreshSnapshot(env, new Date()), cacheStatus: "ERROR" };
  } finally {
    try {
      await cache.delete(FUND_REFRESH_LOCK_KEY);
    } catch (error) {
      console.warn(JSON.stringify({ event: "refresh_lock_delete_failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

async function getSnapshot(env: Env, forceRefresh: boolean): Promise<SnapshotResult> {
  const cache = cacheBinding(env);
  const cached = await readCachedSnapshot(cache);
  const cacheTtl = parseInteger(env.CACHE_TTL, 300, 60, 3_600);

  if (forceRefresh) return refreshSnapshot(env, "forced", cached);
  if (cached && isFreshSnapshot(cached, cacheTtl)) return { snapshot: cached, cacheStatus: "HIT" };
  return refreshSnapshot(env, "request", cached);
}

function validateQuery(url: URL): { category: string; keyword: string; refresh: boolean; token: string } | Response {
  const category = (url.searchParams.get("category") ?? "").trim();
  const keyword = (url.searchParams.get("keyword") ?? "").trim();
  const refreshValue = url.searchParams.get("refresh") ?? "0";
  const token = url.searchParams.get("token") ?? "";

  if (category.length > 32) return errorResponse("category 参数过长", 400);
  if (keyword.length > 64) return errorResponse("keyword 参数过长", 400);
  if (token.length > 256) return errorResponse("token 参数过长", 400);
  if (refreshValue !== "0" && refreshValue !== "1") return errorResponse("refresh 参数无效", 400);
  if (category && !categoryOrder().includes(category)) return errorResponse("category 不存在", 400);
  return { category, keyword, refresh: refreshValue === "1", token };
}

async function handleFunds(request: Request, env: Env): Promise<Response> {
  const validated = validateQuery(new URL(request.url));
  if (validated instanceof Response) return validated;

  if (validated.refresh) {
    if (!env.REFRESH_TOKEN) return errorResponse("强制刷新功能尚未配置", 503);
    if (!validated.token || !(await secureTokenEqual(validated.token, env.REFRESH_TOKEN))) {
      return errorResponse("强制刷新密钥错误", 403);
    }
  }

  const result = await getSnapshot(env, validated.refresh);
  const filtered = filterSnapshot(result.snapshot, validated.category, validated.keyword);
  return jsonResponse(
    { success: true, message: "ok", data: filtered },
    200,
    { "x-fund-cache": result.cacheStatus },
  );
}

async function handleHealth(env: Env): Promise<Response> {
  const data: HealthData = {
    status: "ok",
    time: toBeijingIso(),
    cacheAvailable: Boolean(cacheBinding(env)),
  };
  return jsonResponse({ success: true, message: "ok", data });
}

function isOfficialNavBatchCache(value: unknown): value is OfficialNavBatchCache {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  if (typeof item.checkedAt !== "string" || !Array.isArray(item.funds)) return false;
  return item.funds.every((fund) => {
    if (typeof fund !== "object" || fund === null) return false;
    const record = fund as Record<string, unknown>;
    return typeof record.code === "string" && /^\d{6}$/.test(record.code) &&
      typeof record.name === "string" &&
      typeof record.officialNav === "number" && Number.isFinite(record.officialNav) &&
      (record.officialChangePct === null || (typeof record.officialChangePct === "number" && Number.isFinite(record.officialChangePct))) &&
      typeof record.navDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.navDate);
  });
}

function isOfficialNavCacheFresh(value: OfficialNavBatchCache, now = Date.now()): boolean {
  const checkedAt = Date.parse(value.checkedAt);
  if (!Number.isFinite(checkedAt) || now < checkedAt) return false;
  const ageSeconds = (now - checkedAt) / 1_000;
  const today = toBeijingIso(now).slice(0, 10);
  if (value.funds.length > 0 && value.funds.every((fund) => fund.navDate === today)) {
    return ageSeconds < OFFICIAL_NAV_TODAY_FRESH_SECONDS;
  }
  const beijingHour = new Date(now + 8 * 60 * 60 * 1_000).getUTCHours();
  const freshness = beijingHour >= 17 ? OFFICIAL_NAV_EVENING_FRESH_SECONDS : OFFICIAL_NAV_DAYTIME_FRESH_SECONDS;
  return ageSeconds < freshness;
}

async function enrichWithOfficialNav(funds: FundEstimate[], env: Env): Promise<FundEstimate[]> {
  if (!funds.length) return funds;
  const codes = funds.map((fund) => fund.code).sort();
  const cache = cacheBinding(env);
  const cacheKey = `${OFFICIAL_NAV_CACHE_PREFIX}${codes.join(",")}`;
  let cached: OfficialNavBatchCache | null = null;
  if (cache) {
    try {
      const value: unknown = await cache.get(cacheKey, "json");
      if (isOfficialNavBatchCache(value)) cached = value;
    } catch (error) {
      console.warn(JSON.stringify({ event: "official_nav_cache_read_failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }

  let records = cached?.funds ?? [];
  let cacheStatus = cached && isOfficialNavCacheFresh(cached) ? "HIT" : "MISS";
  if (cacheStatus === "MISS") {
    try {
      records = await fetchLatestOfficialNavs(codes, parseInteger(env.FUND_API_TIMEOUT, DEFAULT_FUND_API_TIMEOUT, 1_000, 30_000));
      const freshValue: OfficialNavBatchCache = { checkedAt: new Date().toISOString(), funds: records };
      if (cache) {
        try {
          await cache.put(cacheKey, JSON.stringify(freshValue), { expirationTtl: OFFICIAL_NAV_STORAGE_SECONDS });
        } catch (error) {
          console.warn(JSON.stringify({ event: "official_nav_cache_write_failed", error: error instanceof Error ? error.message : String(error) }));
        }
      }
    } catch (error) {
      cacheStatus = cached ? "STALE" : "ERROR";
      console.warn(JSON.stringify({ event: "official_nav_fetch_failed", error: error instanceof Error ? error.message : String(error), usingOldCache: Boolean(cached) }));
    }
  }

  console.log(JSON.stringify({ event: "official_nav_resolved", fundCount: funds.length, officialCount: records.length, cacheStatus }));
  const byCode = new Map(records.map((record) => [record.code, record]));
  return funds.map((fund) => {
    const official = byCode.get(fund.code);
    if (!official) return fund;
    const useOfficialDate = !fund.navDate || official.navDate >= fund.navDate;
    const denominator = official.officialChangePct === null ? null : 1 + official.officialChangePct / 100;
    const previousNav = denominator !== null && denominator > 0
      ? Math.round((official.officialNav / denominator) * 10_000) / 10_000
      : fund.previousNav;
    return {
      ...fund,
      name: official.name || fund.name,
      previousNav,
      officialNav: official.officialNav,
      officialChangePct: official.officialChangePct,
      navDate: useOfficialDate ? official.navDate : fund.navDate,
      source: "天天基金正式净值接口",
      status: fund.status === "failed" ? "stale" : fund.status,
      ...(fund.status === "failed" ? { error: "盘中估算已下线，当前显示最新正式净值" } : {}),
    };
  });
}

function officialNavPlaceholder(fund: { code: string; name: string; category: string }): FundEstimate {
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
    source: "天天基金正式净值接口",
    status: "failed",
    error: "正式净值暂不可用",
  };
}

async function handleCustomFunds(request: Request, env: Env): Promise<Response> {
  const rawCodes = new URL(request.url).searchParams.get("codes") ?? "";
  if (rawCodes.length > 209) return errorResponse("codes 参数过长", 400);
  const codes = [...new Set(rawCodes.split(",").map((code) => code.trim()).filter(Boolean))];
  if (codes.length > 30 || codes.some((code) => !/^\d{6}$/.test(code))) return errorResponse("基金代码格式无效", 400);
  if (codes.length === 0) return jsonResponse({ success: true, message: "ok", data: { funds: [] } });
  const funds = codes.map((code) => ({ code, name: code, category: "自定义" }));
  const options = providerOptions(env, new Date());
  const enrichedFunds = options.useMockData
    ? (await fetchFundEstimates(funds, options)).funds
    : await enrichWithOfficialNav(funds.map(officialNavPlaceholder), env);
  return jsonResponse({ success: true, message: "ok", data: { funds: enrichedFunds } });
}

function isThemeAnalysis(value: unknown): value is FundThemeAnalysis {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.code === "string" && typeof item.theme === "string" &&
    (item.reportDate === null || typeof item.reportDate === "string") &&
    typeof item.holdingsCount === "number" && Array.isArray(item.basis) &&
    item.basis.every((entry) => typeof entry === "string") && typeof item.analyzedAt === "string";
}

async function handleFundTheme(request: Request, env: Env): Promise<Response> {
  const code = (new URL(request.url).searchParams.get("code") ?? "").trim();
  if (!/^\d{6}$/.test(code)) return errorResponse("基金代码格式无效", 400);
  const cache = cacheBinding(env);
  const cacheKey = `${THEME_CACHE_PREFIX}${code}`;
  if (cache) {
    try {
      const cached: unknown = await cache.get(cacheKey, "json");
      if (isThemeAnalysis(cached)) {
        const age = Date.now() - Date.parse(cached.analyzedAt);
        if (Number.isFinite(age) && age < THEME_FRESH_SECONDS * 1_000) {
          return jsonResponse({ success: true, message: "ok", data: cached }, 200, { "x-fund-theme-cache": "HIT" });
        }
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "theme_cache_read_failed", fundCode: code, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  try {
    const timeoutMs = parseInteger(env.FUND_API_TIMEOUT, DEFAULT_FUND_API_TIMEOUT, 1_000, 30_000);
    const analysis = await fetchFundThemeFromHoldings(code, timeoutMs);
    if (cache) {
      try {
        await cache.put(cacheKey, JSON.stringify(analysis), { expirationTtl: THEME_STORAGE_SECONDS });
      } catch (error) {
        console.warn(JSON.stringify({ event: "theme_cache_write_failed", fundCode: code, error: error instanceof Error ? error.message : String(error) }));
      }
    }
    console.log(JSON.stringify({ event: "fund_theme_analyzed", fundCode: code, theme: analysis.theme, reportDate: analysis.reportDate, holdingsCount: analysis.holdingsCount }));
    return jsonResponse({ success: true, message: "ok", data: analysis }, 200, { "x-fund-theme-cache": cache ? "MISS" : "BYPASS" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "持仓主题分析失败";
    console.warn(JSON.stringify({ event: "fund_theme_failed", fundCode: code, error: message }));
    return errorResponse(message, 502);
  }
}

function methodNotAllowed(): Response {
  return jsonResponse({ success: false, message: "method not allowed", data: null }, 405, { allow: "GET" });
}

function scheduledLog(event: string, controller: ScheduledController, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, cron: controller.cron, scheduledTime: new Date(controller.scheduledTime).toISOString(), ...extra }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method !== "GET") return methodNotAllowed();
      try {
        if (url.pathname === "/api/funds") return await handleFunds(request, env);
        if (url.pathname === "/api/custom-funds") return await handleCustomFunds(request, env);
        if (url.pathname === "/api/fund-theme") return await handleFundTheme(request, env);
        if (url.pathname === "/api/health") return await handleHealth(env);
        return errorResponse("not found", 404);
      } catch (error) {
        console.error(JSON.stringify({ event: "api_unhandled_error", path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
        return errorResponse("服务暂时不可用", 500);
      }
    }

    return errorResponse("not found", 404);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (!isBeijingTradingSession(controller.scheduledTime)) {
      scheduledLog("cron_skipped_outside_trading_session", controller);
      return;
    }
    if (!cacheBinding(env)) {
      scheduledLog("cron_skipped_no_kv", controller);
      return;
    }

    scheduledLog("cron_refresh_started", controller, { total: FUND_LIST.length });
    const previous = await readCachedSnapshot(cacheBinding(env));
    const result = await refreshSnapshot(env, "cron", previous);
    scheduledLog("cron_refresh_finished", controller, {
      cacheStatus: result.cacheStatus,
      successCount: result.snapshot.successCount,
      failedCount: result.snapshot.failedCount,
    });
  },
} satisfies ExportedHandler<Env>;
