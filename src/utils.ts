import type { FundEstimate, FundSnapshot } from "./types";

export const FUND_CACHE_KEY = "fund_snapshot_latest";
export const FUND_REFRESH_LOCK_KEY = "fund_refresh_lock";
export const REFRESH_LOCK_TTL_SECONDS = 60;
export const STALE_CACHE_TTL_SECONDS = 86_400;

export function parseInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function toBeijingIso(timestamp = Date.now()): string {
  const date = new Date(timestamp + 8 * 60 * 60 * 1_000);
  return `${date.toISOString().slice(0, 19)}+08:00`;
}

export function isBeijingTradingSession(timestamp: number): boolean {
  const date = new Date(timestamp + 8 * 60 * 60 * 1_000);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;

  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900);
}

export function sortFunds(funds: readonly FundEstimate[], categoryOrder: readonly string[], descending = true): FundEstimate[] {
  return [...funds].sort((left, right) => {
    const categoryDifference = categoryOrder.indexOf(left.category) - categoryOrder.indexOf(right.category);
    if (categoryDifference !== 0) return categoryDifference;

    const leftValue = left.estimatedChangePct ?? left.officialChangePct;
    const rightValue = right.estimatedChangePct ?? right.officialChangePct;
    if (leftValue === null && rightValue === null) return left.code.localeCompare(right.code);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return descending ? rightValue - leftValue : leftValue - rightValue;
  });
}

export function createSnapshot(funds: FundEstimate[], dataSource: string, updatedAt = toBeijingIso()): FundSnapshot {
  return {
    updatedAt,
    dataSource,
    total: funds.length,
    successCount: funds.filter((fund) => fund.status !== "failed").length,
    failedCount: funds.filter((fund) => fund.status === "failed").length,
    funds,
  };
}

export function isFreshSnapshot(snapshot: FundSnapshot, cacheTtlSeconds: number, now = Date.now()): boolean {
  const updatedAt = Date.parse(snapshot.updatedAt);
  return Number.isFinite(updatedAt) && now - updatedAt < cacheTtlSeconds * 1_000;
}

export function markSnapshotStale(snapshot: FundSnapshot): FundSnapshot {
  const funds = snapshot.funds.map((fund) => ({
    ...fund,
    status: "stale" as const,
    error: fund.error ?? "正在使用上一次缓存数据",
  }));
  return createSnapshot(funds, `${snapshot.dataSource}（缓存）`, snapshot.updatedAt);
}

export function filterSnapshot(snapshot: FundSnapshot, category: string, keyword: string): FundSnapshot {
  const normalizedKeyword = keyword.toLocaleLowerCase("zh-CN");
  const funds = snapshot.funds.filter((fund) => {
    const categoryMatches = !category || fund.category === category;
    const keywordMatches = !normalizedKeyword ||
      fund.name.toLocaleLowerCase("zh-CN").includes(normalizedKeyword) ||
      fund.code.includes(normalizedKeyword) ||
      fund.category.toLocaleLowerCase("zh-CN").includes(normalizedKeyword);
    return categoryMatches && keywordMatches;
  });
  return createSnapshot(funds, snapshot.dataSource, snapshot.updatedAt);
}

export async function secureTokenEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isFundSnapshot(value: unknown): value is FundSnapshot {
  if (!isRecord(value) || !Array.isArray(value.funds)) return false;
  if (typeof value.updatedAt !== "string" || typeof value.dataSource !== "string") return false;
  if (typeof value.total !== "number" || typeof value.successCount !== "number" || typeof value.failedCount !== "number") return false;

  return value.funds.every((fund) => {
    if (!isRecord(fund)) return false;
    return typeof fund.code === "string" &&
      typeof fund.name === "string" &&
      typeof fund.category === "string" &&
      (fund.estimatedNav === null || typeof fund.estimatedNav === "number") &&
      (fund.estimatedChangePct === null || typeof fund.estimatedChangePct === "number") &&
      (fund.previousNav === null || typeof fund.previousNav === "number") &&
      (fund.officialNav === null || typeof fund.officialNav === "number") &&
      (fund.officialChangePct === null || typeof fund.officialChangePct === "number") &&
      (fund.navDate === null || typeof fund.navDate === "string") &&
      (fund.estimateTime === null || typeof fund.estimateTime === "string") &&
      typeof fund.source === "string" &&
      (fund.status === "success" || fund.status === "failed" || fund.status === "stale");
  });
}
