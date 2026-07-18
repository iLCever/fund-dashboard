export interface FundConfig {
  code: string;
  name: string;
  category: string;
}

export interface FundEstimate {
  code: string;
  name: string;
  category: string;
  estimatedNav: number | null;
  estimatedChangePct: number | null;
  previousNav: number | null;
  officialNav: number | null;
  navDate: string | null;
  estimateTime: string | null;
  source: string;
  status: "success" | "failed" | "stale";
  error?: string;
}

export interface FundSnapshot {
  updatedAt: string;
  dataSource: string;
  total: number;
  successCount: number;
  failedCount: number;
  funds: FundEstimate[];
}

export interface HealthData {
  status: "ok";
  time: string;
  cacheAvailable: boolean;
}

export interface ApiResponse<T> {
  success: boolean;
  message: string;
  data: T;
}
