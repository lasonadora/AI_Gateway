// health 技能的数字部分：基线、状态分、异常规则。纯函数，无依赖。
// 直接用 Node 22.18+ / 24 运行（原生去类型）：
//   node analyze.ts --input daily.json [--labs labs.json] --date 2026-10-25
//   node analyze.ts --input daily.json --weekly --date 2026-10-26
// 输出 JSON 到 stdout。模型只负责把这些数字写成人话。

export type DailyMetric = {
  date: string; // YYYY-MM-DD
  sleep_hours?: number | null;
  hrv_ms?: number | null;
  resting_hr?: number | null;
  spo2_min?: number | null;
  steps?: number | null;
  active_min?: number | null;
  workouts?: string | null;
  weight_kg?: number | null;
  source?: string | null;
};

export type Lab = {
  marker: string;
  date?: string;
  value?: number | null;
  unit?: string | null;
  ref_range?: string | null;
  flag?: string | null; // 正常 / 偏高 / 偏低
};

export type Baseline = { median: number; mad: number; n: number };

export type Anomaly = { rule: string; detail: string };

export type DailyResult = {
  date: string;
  insufficient: boolean;
  score: number | null;
  components: {
    sleep: number | null;
    hrv: number | null;
    resting_hr: number | null;
    activity: number | null;
  };
  yesterday: {
    sleep_hours: number | null;
    hrv_ms: number | null;
    hrv_7d_mean: number | null;
    resting_hr: number | null;
    spo2_min: number | null;
    active_min: number | null;
    steps: number | null;
    workouts: string | null;
  };
  baselines: {
    sleep_hours: Baseline | null;
    hrv_ms: Baseline | null;
    resting_hr: Baseline | null;
    active_min: Baseline | null;
  };
  source_used: string | null;
  anomalies: Anomaly[];
};

// 权重：步数和卡路里不参与（误差两三成）。周报可以提议调整。
export const WEIGHTS = { sleep: 0.3, hrv: 0.35, resting_hr: 0.3, activity: 0.05 };
export const MIN_DAYS = 7;

// ---------- 基础统计 ----------

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// 中位数绝对偏差：比标准差抗单日异常值
export function mad(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function isNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function addDays(date: string, delta: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ---------- 数据准备 ----------

// 只用同一设备来源的数据做基线：多设备混用会让 HRV 基线漂移。
// 来源 = 最近 28 天里出现最多的 source；没有 source 字段则不筛。
export function pickSource(rows: DailyMetric[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.source) counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [s, n] of counts) if (n > bestN) [best, bestN] = [s, n];
  return best;
}

// 取 date 之前（含）window 天的行，按日期升序，去重（同一天取最后一条）
export function windowRows(rows: DailyMetric[], date: string, window: number, source: string | null): DailyMetric[] {
  const from = addDays(date, -(window - 1));
  const byDate = new Map<string, DailyMetric>();
  for (const r of rows) {
    if (!r.date || r.date < from || r.date > date) continue;
    if (source && r.source && r.source !== source) continue;
    byDate.set(r.date, r);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function series(rows: DailyMetric[], key: keyof DailyMetric): number[] {
  return rows.map((r) => r[key]).filter(isNum) as number[];
}

export function baseline(rows: DailyMetric[], key: keyof DailyMetric): Baseline | null {
  const xs = series(rows, key);
  if (xs.length < MIN_DAYS) return null;
  return { median: median(xs), mad: mad(xs), n: xs.length };
}

// ---------- 状态分 ----------

// 每一项映射到 0..1：在基线上是 1，明显差于基线是 0。
export function sleepComponent(hours: number, base: Baseline): number {
  const ratio = hours / base.median; // 基线的 70% 以下记 0
  return clamp01((ratio - 0.7) / 0.3);
}

export function hrvComponent(hrv7: number, base: Baseline): number {
  const ratio = hrv7 / base.median; // 基线的 75% 以下记 0
  return clamp01((ratio - 0.75) / 0.25);
}

export function restingHrComponent(rhr: number, base: Baseline): number {
  const delta = rhr - base.median; // 高出基线 8 bpm 记 0；低于基线不加分
  return clamp01(1 - delta / 8);
}

export function activityComponent(activeMin: number | null, base: Baseline | null): number {
  if (!isNum(activeMin) || !base) return 0.5; // 不知道就给中性分
  const lo = base.median * 0.5;
  const hi = base.median * 1.5;
  return activeMin >= lo && activeMin <= hi ? 1 : 0.5;
}

// ---------- 异常规则 ----------

export function detectAnomalies(
  rows28: DailyMetric[],
  date: string,
  labs: Lab[],
  bases: { hrv: Baseline | null; rhr: Baseline | null },
): Anomaly[] {
  const out: Anomaly[] = [];
  const last = (n: number) => rows28.slice(-n);
  const rows7 = windowRows(rows28, date, 7, null);
  const hrv7 = series(rows7, "hrv_ms");
  const hrv7mean = hrv7.length ? mean(hrv7) : null;
  const yday = rows28.find((r) => r.date === date) ?? null;

  // 1. 复合恢复不足（最高优先级）：HRV 7 天均值比 28 天中位数低 10% 以上，且静息心率高 3 bpm 以上
  if (bases.hrv && bases.rhr && hrv7mean !== null && yday && isNum(yday.resting_hr)) {
    const hrvDrop = 1 - hrv7mean / bases.hrv.median;
    const rhrUp = yday.resting_hr - bases.rhr.median;
    if (hrvDrop >= 0.10 && rhrUp >= 3) {
      out.push({
        rule: "复合恢复不足",
        detail: `HRV 7 天均值 ${hrv7mean.toFixed(0)} ms，比 28 天中位数低 ${(hrvDrop * 100).toFixed(0)}%；静息心率 ${yday.resting_hr} bpm，高出中位数 ${rhrUp.toFixed(0)}`,
      });
    }
  }

  // 2. 静息心率升高：连续 2 天高于 28 天中位数 5 bpm 以上
  if (bases.rhr) {
    const two = last(2).map((r) => r.resting_hr).filter(isNum) as number[];
    if (two.length === 2 && two.every((v) => v - bases.rhr!.median >= 5)) {
      out.push({ rule: "静息心率升高", detail: `连续 2 天 ${two.join("/")} bpm，高出中位数 ${bases.rhr.median.toFixed(0)} 至少 5` });
    }
  }

  // 3. 睡眠不足：连续 3 晚少于 6 小时
  {
    const three = last(3).map((r) => r.sleep_hours).filter(isNum) as number[];
    if (three.length === 3 && three.every((h) => h < 6)) {
      out.push({ rule: "睡眠不足", detail: `连续 3 晚 ${three.map((h) => h.toFixed(1)).join("/")} 小时` });
    }
  }

  // 4. HRV 下降：7 天均值低于 28 天中位数 15% 以上
  if (bases.hrv && hrv7mean !== null) {
    const drop = 1 - hrv7mean / bases.hrv.median;
    if (drop >= 0.15) {
      out.push({ rule: "HRV 下降", detail: `7 天均值 ${hrv7mean.toFixed(0)} ms，比 28 天中位数 ${bases.hrv.median.toFixed(0)} 低 ${(drop * 100).toFixed(0)}%` });
    }
  }

  // 5. 血氧偏低：最近 7 晚里夜间最低值低于 90% 出现 2 晚以上
  {
    const lowNights = rows7.filter((r) => isNum(r.spo2_min) && (r.spo2_min as number) < 90).length;
    if (lowNights >= 2) {
      out.push({ rule: "血氧偏低", detail: `最近 7 晚有 ${lowNights} 晚最低血氧低于 90%` });
    }
  }

  // 6. 化验超范围
  for (const lab of labs) {
    if (lab.flag === "偏高" || lab.flag === "偏低") {
      out.push({
        rule: "化验超范围",
        detail: `${lab.marker} ${lab.value ?? "?"} ${lab.unit ?? ""}（参考 ${lab.ref_range ?? "未知"}，${lab.flag}${lab.date ? "，" + lab.date : ""}）`,
      });
    }
  }

  return out;
}

// ---------- 主函数 ----------

export function analyzeDaily(rows: DailyMetric[], date: string, labs: Lab[] = []): DailyResult {
  const source = pickSource(windowRows(rows, date, 28, null));
  const rows28 = windowRows(rows, date, 28, source);
  const rows7 = windowRows(rows28, date, 7, null);
  const yday = rows28.find((r) => r.date === date) ?? null;

  const bSleep = baseline(rows28, "sleep_hours");
  const bHrv = baseline(rows28, "hrv_ms");
  const bRhr = baseline(rows28, "resting_hr");
  const bAct = baseline(rows28, "active_min");

  const hrv7 = series(rows7, "hrv_ms");
  const hrv7mean = hrv7.length ? mean(hrv7) : null;

  const anomalies = detectAnomalies(rows28, date, labs, { hrv: bHrv, rhr: bRhr });

  const insufficient = !bSleep || !bHrv || !bRhr || !yday;

  let components: DailyResult["components"] = { sleep: null, hrv: null, resting_hr: null, activity: null };
  let score: number | null = null;

  if (!insufficient && yday) {
    const s = isNum(yday.sleep_hours) ? sleepComponent(yday.sleep_hours, bSleep!) : null;
    const h = hrv7mean !== null ? hrvComponent(hrv7mean, bHrv!) : null;
    const r = isNum(yday.resting_hr) ? restingHrComponent(yday.resting_hr, bRhr!) : null;
    const a = activityComponent(isNum(yday.active_min) ? yday.active_min : null, bAct);
    const r2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
    components = { sleep: r2(s), hrv: r2(h), resting_hr: r2(r), activity: r2(a) };
    // 某一项缺昨天的值就按该项权重归一化，不把缺失当 0
    let wsum = 0;
    let acc = 0;
    for (const [k, v] of Object.entries(components) as [keyof typeof WEIGHTS, number | null][]) {
      if (v === null) continue;
      acc += v * WEIGHTS[k];
      wsum += WEIGHTS[k];
    }
    score = wsum > 0 ? Math.round((acc / wsum) * 100) : null;
  }

  return {
    date,
    insufficient,
    score,
    components,
    yesterday: {
      sleep_hours: yday && isNum(yday.sleep_hours) ? yday.sleep_hours : null,
      hrv_ms: yday && isNum(yday.hrv_ms) ? yday.hrv_ms : null,
      hrv_7d_mean: hrv7mean === null ? null : Math.round(hrv7mean * 10) / 10,
      resting_hr: yday && isNum(yday.resting_hr) ? yday.resting_hr : null,
      spo2_min: yday && isNum(yday.spo2_min) ? yday.spo2_min : null,
      active_min: yday && isNum(yday.active_min) ? yday.active_min : null,
      steps: yday && isNum(yday.steps) ? yday.steps : null,
      workouts: yday?.workouts ?? null,
    },
    baselines: { sleep_hours: bSleep, hrv_ms: bHrv, resting_hr: bRhr, active_min: bAct },
    source_used: source,
    anomalies,
  };
}

export type WeeklyResult = {
  week_end: string;
  this_week: Record<string, number | null>;
  last_week: Record<string, number | null>;
  anomaly_counts: Record<string, number>;
  days_with_data: number;
};

// 周报：本周 vs 上周的中位数，和本周每天跑日报规则命中的次数
export function analyzeWeekly(rows: DailyMetric[], weekEnd: string, labs: Lab[] = []): WeeklyResult {
  const med = (rs: DailyMetric[], k: keyof DailyMetric) => {
    const xs = series(rs, k);
    return xs.length ? Math.round(median(xs) * 10) / 10 : null;
  };
  const thisWeek = windowRows(rows, weekEnd, 7, null);
  const lastWeek = windowRows(rows, addDays(weekEnd, -7), 7, null);
  const keys: (keyof DailyMetric)[] = ["sleep_hours", "hrv_ms", "resting_hr", "spo2_min", "active_min", "weight_kg"];
  const pack = (rs: DailyMetric[]) => Object.fromEntries(keys.map((k) => [k, med(rs, k)]));

  const counts: Record<string, number> = {};
  for (const r of thisWeek) {
    for (const a of analyzeDaily(rows, r.date, labs).anomalies) counts[a.rule] = (counts[a.rule] ?? 0) + 1;
  }
  return { week_end: weekEnd, this_week: pack(thisWeek), last_week: pack(lastWeek), anomaly_counts: counts, days_with_data: thisWeek.length };
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const fs = await import("node:fs");
  const input = get("--input");
  if (!input) {
    console.error("用法: node analyze.ts --input daily.json [--labs labs.json] --date YYYY-MM-DD [--weekly]");
    process.exit(2);
  }
  const rows = JSON.parse(fs.readFileSync(input, "utf8")) as DailyMetric[];
  const labsPath = get("--labs");
  const labs = labsPath && fs.existsSync(labsPath) ? (JSON.parse(fs.readFileSync(labsPath, "utf8")) as Lab[]) : [];
  const date = get("--date") ?? addDays(new Date().toISOString().slice(0, 10), -1);
  const result = args.includes("--weekly") ? analyzeWeekly(rows, date, labs) : analyzeDaily(rows, date, labs);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

const isCli = typeof process !== "undefined" && process.argv[1] && /analyze\.(ts|js)$/.test(process.argv[1]);
if (isCli) main();
