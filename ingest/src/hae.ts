const TZ = process.env.TZ || "Asia/Shanghai";

// Health Auto Export 的 JSON → 每日汇总。纯函数，便于测试。
// ---------- Health Auto Export JSON（v2）→ 每日汇总 ----------
// HAE 的 payload 形如 { data: { metrics: [ { name, units, data: [ { date, qty | Avg/Min/Max | 睡眠字段... } ] } ], workouts: [...] } }
// 指标名因设置而异，下面按最常见的名字映射；不认识的忽略。

export type Daily = {
  date: string;
  sleep_start?: string;
  sleep_end?: string;
  sleep_hours?: number;
  hrv_ms?: number;
  resting_hr?: number;
  spo2_min?: number;
  steps?: number;
  active_min?: number;
  workouts?: string;
  weight_kg?: number;
};

function localDate(iso: string): string {
  // HAE 的 date 形如 "2026-10-25 07:12:33 +0800"；取本地日期部分
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: TZ }); // sv-SE 给 YYYY-MM-DD
}

function num(x: unknown): number | undefined {
  const n = typeof x === "string" ? Number(x) : (x as number);
  return Number.isFinite(n) ? n : undefined;
}

export function aggregate(payload: any): Daily[] {
  const days = new Map<string, Daily>();
  const get = (d: string) => days.get(d) ?? (days.set(d, { date: d }), days.get(d)!);

  const metrics: any[] = payload?.data?.metrics ?? [];
  for (const m of metrics) {
    const name = String(m.name ?? "").toLowerCase();
    for (const p of m.data ?? []) {
      const d = localDate(String(p.date ?? ""));
      if (!d) continue;
      const row = get(d);
      if (name === "sleep_analysis") {
        // 睡眠：totalSleep 或 asleep（小时），sleepStart/sleepEnd
        const hours = num(p.totalSleep ?? p.asleep);
        if (hours !== undefined) row.sleep_hours = Math.round(hours * 10) / 10;
        if (p.sleepStart) row.sleep_start = String(p.sleepStart);
        if (p.sleepEnd) row.sleep_end = String(p.sleepEnd);
      } else if (name === "heart_rate_variability") {
        const v = num(p.qty ?? p.Avg);
        if (v !== undefined) row.hrv_ms = Math.round(v);
      } else if (name === "resting_heart_rate") {
        const v = num(p.qty ?? p.Avg);
        if (v !== undefined) row.resting_hr = Math.round(v);
      } else if (name === "blood_oxygen_saturation") {
        // 取当天最低值；HAE 可能给 Min 或多个样本的 qty
        const v = num(p.Min ?? p.qty);
        if (v !== undefined) {
          const pct = v <= 1 ? v * 100 : v;
          row.spo2_min = row.spo2_min === undefined ? Math.round(pct) : Math.min(row.spo2_min, Math.round(pct));
        }
      } else if (name === "step_count") {
        const v = num(p.qty);
        if (v !== undefined) row.steps = (row.steps ?? 0) + Math.round(v);
      } else if (name === "apple_exercise_time") {
        const v = num(p.qty);
        if (v !== undefined) row.active_min = (row.active_min ?? 0) + Math.round(v);
      } else if (name === "weight_body_mass") {
        const v = num(p.qty);
        if (v !== undefined) row.weight_kg = Math.round(v * 10) / 10;
      }
    }
  }

  const workouts: any[] = payload?.data?.workouts ?? [];
  for (const w of workouts) {
    const d = localDate(String(w.start ?? w.date ?? ""));
    if (!d) continue;
    const row = get(d);
    const mins = w.duration ? Math.round(Number(w.duration) / 60) : undefined; // HAE duration 为秒
    const item = `${w.name ?? "锻炼"}${mins ? " " + mins + "min" : ""}`;
    row.workouts = row.workouts ? `${row.workouts}; ${item}` : item;
  }

  return [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

