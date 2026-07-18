export interface FundProviderOptions {
  apiUrl: string;
  timeoutMs: number;
  maxConcurrency: number;
  useMockData: boolean;
  now: Date;
}

export interface ProviderBatchResult {
  funds: import("../types").FundEstimate[];
  dataSource: string;
  durationMs: number;
}

export interface EastmoneyFundEstimateResponse {
  fundcode?: unknown;
  name?: unknown;
  jzrq?: unknown;
  dwjz?: unknown;
  gsz?: unknown;
  gszzl?: unknown;
  gztime?: unknown;
}

export interface EastmoneyOfficialNavItem {
  FCODE?: unknown;
  SHORTNAME?: unknown;
  PDATE?: unknown;
  NAV?: unknown;
}

export interface EastmoneyOfficialNavResponse {
  Datas?: unknown;
  Success?: unknown;
}

export interface OfficialNavRecord {
  code: string;
  officialNav: number;
  navDate: string;
}

export interface FundThemeAnalysis {
  code: string;
  theme: string;
  reportDate: string | null;
  holdingsCount: number;
  basis: string[];
  analyzedAt: string;
}
