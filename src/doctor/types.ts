// src/doctor/types.ts

export type CheckStatus = "ok" | "warn" | "fail";

export type CheckResult = {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
};

export type DoctorReport = {
  started_at: string;
  finished_at: string;
  results: CheckResult[];
  summary: {
    ok: number;
    warn: number;
    fail: number;
  };
  exit_code: 0 | 1 | 2;
};

export type CheckContext = {
  dataHome: string;
  store: import("../sqlite-store.js").SQLiteMemoryStore;
  now: () => Date;
};
