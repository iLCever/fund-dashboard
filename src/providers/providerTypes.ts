import type { FundEstimate } from "../types";

export interface FundProviderOptions {
  apiUrl: string;
  timeoutMs: number;
  maxConcurrency: number;
  useMockData: boolean;
  now: Date;
}

export interface ProviderBatchResult {
  funds: FundEstimate[];
  dataSource: string;
  durationMs: number;
}
