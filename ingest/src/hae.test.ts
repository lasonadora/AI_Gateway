import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "./hae.ts";

const sample = {
  data: {
    metrics: [
      { name: "sleep_analysis", units: "hr", data: [{ date: "2026-10-25 07:10:00 +0800", totalSleep: 6.42, sleepStart: "2026-10-24 23:50:00 +0800", sleepEnd: "2026-10-25 07:05:00 +0800" }] },
      { name: "heart_rate_variability", units: "ms", data: [{ date: "2026-10-25 03:00:00 +0800", qty: 47.6 }] },
      { name: "resting_heart_rate", units: "count/min", data: [{ date: "2026-10-25 00:00:00 +0800", qty: 57.2 }] },
      { name: "blood_oxygen_saturation", units: "%", data: [{ date: "2026-10-25 02:00:00 +0800", qty: 0.96 }, { date: "2026-10-25 04:00:00 +0800", qty: 0.91 }] },
      { name: "step_count", units: "count", data: [{ date: "2026-10-25 09:00:00 +0800", qty: 1200 }, { date: "2026-10-25 18:00:00 +0800", qty: 6300.4 }] },
      { name: "apple_exercise_time", units: "min", data: [{ date: "2026-10-25 18:00:00 +0800", qty: 32 }] },
      { name: "weight_body_mass", units: "kg", data: [{ date: "2026-10-25 07:30:00 +0800", qty: 70.26 }] },
      { name: "something_unknown", units: "x", data: [{ date: "2026-10-25 07:30:00 +0800", qty: 1 }] },
    ],
    workouts: [{ name: "Running", start: "2026-10-25 18:00:00 +0800", duration: 1860 }],
  },
};

test("HAE payload 聚合成每日一行", () => {
  const rows = aggregate(sample);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.date, "2026-10-25");
  assert.equal(r.sleep_hours, 6.4);
  assert.equal(r.hrv_ms, 48);
  assert.equal(r.resting_hr, 57);
  assert.equal(r.spo2_min, 91); // 取最低，0.91 → 91%
  assert.equal(r.steps, 7500);
  assert.equal(r.active_min, 32);
  assert.equal(r.weight_kg, 70.3);
  assert.equal(r.workouts, "Running 31min");
  assert.ok(r.sleep_start?.startsWith("2026-10-24"));
});

test("跨天的数据分到各自的日期", () => {
  const rows = aggregate({
    data: { metrics: [{ name: "step_count", data: [{ date: "2026-10-24 23:00:00 +0800", qty: 100 }, { date: "2026-10-25 01:00:00 +0800", qty: 200 }] }] },
  });
  assert.deepEqual(rows.map((r) => [r.date, r.steps]), [["2026-10-24", 100], ["2026-10-25", 200]]);
});

test("空 payload 不报错", () => {
  assert.deepEqual(aggregate({}), []);
});
