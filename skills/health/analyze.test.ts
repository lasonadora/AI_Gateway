// node --test skills/health/
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDaily, analyzeWeekly, median, mad, type DailyMetric } from "./analyze.ts";

function day(i: number): string {
  const d = new Date("2026-10-01T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}

// 28 天稳定数据：睡 7.5h，HRV 50，静息 55，活动 40 分钟
function stableRows(n = 28, overrides: Partial<DailyMetric> = {}): DailyMetric[] {
  return Array.from({ length: n }, (_, i) => ({
    date: day(i),
    sleep_hours: 7.5,
    hrv_ms: 50,
    resting_hr: 55,
    spo2_min: 95,
    steps: 8000,
    active_min: 40,
    source: "HealthKit",
    ...overrides,
  }));
}

test("median 和 mad", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(mad([1, 2, 3, 4, 100]), 1); // 单个离群值不影响
});

test("数据不足 7 天：不打分，insufficient 为 true", () => {
  const r = analyzeDaily(stableRows(5), day(4));
  assert.equal(r.insufficient, true);
  assert.equal(r.score, null);
  assert.deepEqual(r.anomalies, []);
});

test("一切正常：分数接近 100，无异常", () => {
  const r = analyzeDaily(stableRows(), day(27));
  assert.equal(r.insufficient, false);
  assert.ok(r.score !== null && r.score >= 95, `score=${r.score}`);
  assert.deepEqual(r.anomalies, []);
  assert.equal(r.source_used, "HealthKit");
});

test("昨晚睡得差：分数下降，但单日不触发睡眠不足规则", () => {
  const rows = stableRows();
  rows[27].sleep_hours = 5.5;
  const r = analyzeDaily(rows, day(27));
  assert.ok(r.score !== null && r.score < 95 && r.score > 60, `score=${r.score}`);
  assert.ok(!r.anomalies.some((a) => a.rule === "睡眠不足"));
});

test("连续 3 晚少于 6 小时：触发睡眠不足", () => {
  const rows = stableRows();
  for (const i of [25, 26, 27]) rows[i].sleep_hours = 5.5;
  const r = analyzeDaily(rows, day(27));
  assert.ok(r.anomalies.some((a) => a.rule === "睡眠不足"));
});

test("静息心率连续 2 天高 5 以上：触发静息心率升高", () => {
  const rows = stableRows();
  rows[26].resting_hr = 61;
  rows[27].resting_hr = 62;
  const r = analyzeDaily(rows, day(27));
  assert.ok(r.anomalies.some((a) => a.rule === "静息心率升高"), JSON.stringify(r.anomalies));
});

test("HRV 近 7 天掉两成且心率升高：复合规则优先命中", () => {
  const rows = stableRows();
  for (let i = 21; i <= 27; i++) rows[i].hrv_ms = 40; // 7 天均值 40，比中位数 50 低 20%
  rows[27].resting_hr = 59; // 高 4
  const r = analyzeDaily(rows, day(27));
  assert.equal(r.anomalies[0]?.rule, "复合恢复不足", JSON.stringify(r.anomalies));
  assert.ok(r.anomalies.some((a) => a.rule === "HRV 下降"));
});

test("血氧 7 晚里 2 晚低于 90：触发血氧偏低", () => {
  const rows = stableRows();
  rows[24].spo2_min = 88;
  rows[27].spo2_min = 89;
  const r = analyzeDaily(rows, day(27));
  assert.ok(r.anomalies.some((a) => a.rule === "血氧偏低"));
});

test("化验偏高进异常", () => {
  const r = analyzeDaily(stableRows(), day(27), [{ marker: "空腹血糖", value: 6.5, unit: "mmol/L", ref_range: "3.9-6.1", flag: "偏高" }]);
  assert.ok(r.anomalies.some((a) => a.rule === "化验超范围" && a.detail.includes("空腹血糖")));
});

test("多设备来源：只用最常见的来源做基线", () => {
  const rows = stableRows();
  rows[27] = { ...rows[27], source: "手动", hrv_ms: 999 }; // 另一来源的离群值
  const r = analyzeDaily(rows, day(27));
  assert.equal(r.source_used, "HealthKit");
  assert.equal(r.yesterday.hrv_ms, null); // 昨天那行不是同一来源，被排除
});

test("单日异常值不拉动中位数基线", () => {
  const rows = stableRows();
  rows[10].hrv_ms = 200;
  const r = analyzeDaily(rows, day(27));
  assert.equal(r.baselines.hrv_ms?.median, 50);
});

test("周报：本周 vs 上周中位数和异常计数", () => {
  const rows = stableRows(35);
  for (let i = 28; i < 35; i++) rows[i].sleep_hours = 5.5;
  const w = analyzeWeekly(rows, day(34));
  assert.equal(w.this_week.sleep_hours, 5.5);
  assert.equal(w.last_week.sleep_hours, 7.5);
  assert.ok((w.anomaly_counts["睡眠不足"] ?? 0) >= 5);
  assert.equal(w.days_with_data, 7);
});
