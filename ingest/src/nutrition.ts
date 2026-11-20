// 热量 / 三大营养素：当天累计、和目标的差距、给手机看的几行字。纯函数，数字全在这里算。
import type { Analysis } from "./photo.ts";

export interface Targets {
  kcal: number;
  protein_g: number;
  fat_g: number;
  carb_g: number;
}

/** 没设置时的默认目标：普通成年男性、轻活动、维持体重的常见值。用 /target 改。 */
export const DEFAULT_TARGETS: Targets = { kcal: 2000, protein_g: 120, fat_g: 65, carb_g: 250 };

export interface Totals {
  kcal: number;
  protein_g: number;
  fat_g: number;
  carb_g: number;
  counted: number; // 有热量数字的记录条数
  missing: number; // 饮食记录里没有热量数字的条数（老数据）
}

export interface MacroRow {
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carb_g: number | null;
}

export function sumMacros(rows: MacroRow[]): Totals {
  const t: Totals = { kcal: 0, protein_g: 0, fat_g: 0, carb_g: 0, counted: 0, missing: 0 };
  for (const r of rows) {
    if (r.kcal === null) {
      t.missing++;
      continue;
    }
    t.counted++;
    t.kcal += r.kcal;
    t.protein_g += r.protein_g ?? 0;
    t.fat_g += r.fat_g ?? 0;
    t.carb_g += r.carb_g ?? 0;
  }
  return t;
}

/** "/target 2000 120 65 250" → Targets；"/target" 不带参数 → null（表示只看）。顺序：热量 蛋白 脂肪 碳水。 */
export function parseTargets(arg: string): Targets | null | "bad" {
  const parts = arg.trim().split(/[\s,，/]+/).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length !== 4) return "bad";
  const n = parts.map((x) => Number(x));
  if (n.some((x) => !Number.isFinite(x) || x <= 0)) return "bad";
  const [kcal, protein_g, fat_g, carb_g] = n.map((x) => Math.round(x));
  if (kcal < 800 || kcal > 6000 || protein_g > 400 || fat_g > 300 || carb_g > 800) return "bad";
  return { kcal, protein_g, fat_g, carb_g };
}

const left = (label: string, have: number, goal: number, unit: string) => {
  const d = Math.round(goal - have);
  if (d > 0) return `${label}还差 ${d}${unit}`;
  if (d === 0) return `${label}刚好`;
  return `${label}超 ${-d}${unit}`;
};

/** 这一顿的数字 + 今天累计 + 和目标的差，给手机看。a 可以是 null（比如只想看今天累计）。 */
export function nutritionLines(a: Analysis | null, totals: Totals, targets: Targets): string[] {
  const out: string[] = [];
  if (a && (a.kind === "meal" || a.kind === "drink")) {
    out.push(
      a.kcal === null
        ? "这顿没估出热量"
        : `这顿约 ${a.kcal} 千卡（蛋白 ${a.protein_g ?? "?"}g · 脂肪 ${a.fat_g ?? "?"}g · 碳水 ${a.carb_g ?? "?"}g）`,
    );
  }
  out.push(`今天累计 ${Math.round(totals.kcal)} / ${targets.kcal} 千卡${totals.missing ? `（另有 ${totals.missing} 条没热量数字）` : ""}`);
  out.push([left("蛋白", totals.protein_g, targets.protein_g, "g"), left("脂肪", totals.fat_g, targets.fat_g, "g"), left("碳水", totals.carb_g, targets.carb_g, "g")].join(" · "));
  return out;
}

export function targetsLine(t: Targets): string {
  return `目标：${t.kcal} 千卡 · 蛋白 ${t.protein_g}g · 脂肪 ${t.fat_g}g · 碳水 ${t.carb_g}g`;
}
