import { test } from "node:test";
import assert from "node:assert/strict";
import { sumMacros, parseTargets, nutritionLines, DEFAULT_TARGETS, targetsLine } from "./nutrition.ts";
import { parseAnalysis, calorieBand } from "./photo.ts";

test("parseAnalysis：kcal/宏量解析、档位由 kcal 推出", () => {
  const a = parseAnalysis('{"kind":"meal","title":"牛肉面","items":["牛肉面"],"categories":["主食","蛋白"],"portion":"中","calorie_band":"轻","kcal":650.4,"protein_g":28,"fat_g":18.6,"carb_g":90,"bristol":null,"flags":[],"confidence":0.8,"notes":"","red_flag":false}');
  assert.equal(a.kcal, 650);
  assert.equal(a.fat_g, 19);
  assert.equal(a.calorie_band, "中", "模型说轻，但 650 千卡按代码是中");
  const s = parseAnalysis('{"kind":"stool","title":"排便","items":[],"categories":[],"portion":null,"calorie_band":null,"kcal":300,"protein_g":1,"fat_g":1,"carb_g":1,"bristol":4,"flags":[],"confidence":0.9,"notes":"","red_flag":false}');
  assert.equal(s.kcal, null, "排便不带热量");
  assert.equal(calorieBand(399), "轻");
  assert.equal(calorieBand(800), "中");
  assert.equal(calorieBand(801), "重");
});

test("sumMacros：缺数字的老记录单独计数", () => {
  const t = sumMacros([
    { kcal: 400, protein_g: 20, fat_g: 10, carb_g: 50 },
    { kcal: null, protein_g: null, fat_g: null, carb_g: null },
    { kcal: 650, protein_g: 28, fat_g: 19, carb_g: 90 },
  ]);
  assert.equal(t.kcal, 1050);
  assert.equal(t.protein_g, 48);
  assert.equal(t.counted, 2);
  assert.equal(t.missing, 1);
});

test("parseTargets：空 / 合法 / 非法", () => {
  assert.equal(parseTargets(""), null);
  assert.deepEqual(parseTargets("2200 150 70 260"), { kcal: 2200, protein_g: 150, fat_g: 70, carb_g: 260 });
  assert.deepEqual(parseTargets("1800，130，60，200"), { kcal: 1800, protein_g: 130, fat_g: 60, carb_g: 200 });
  assert.equal(parseTargets("2000 120"), "bad");
  assert.equal(parseTargets("abc 1 2 3"), "bad");
  assert.equal(parseTargets("100 1 1 1"), "bad");
});

test("nutritionLines：这顿 + 累计 + 差距（含超标）", () => {
  const a = parseAnalysis('{"kind":"meal","title":"x","items":["x"],"categories":["主食"],"portion":"中","calorie_band":null,"kcal":850,"protein_g":35,"fat_g":30,"carb_g":110,"bristol":null,"flags":[],"confidence":0.7,"notes":"","red_flag":false}');
  const totals = sumMacros([{ kcal: 1340, protein_g: 65, fat_g: 45, carb_g: 280 }]);
  const lines = nutritionLines(a, totals, DEFAULT_TARGETS);
  assert.equal(lines[0], "这顿约 850 千卡（蛋白 35g · 脂肪 30g · 碳水 110g）");
  assert.equal(lines[1], "今天累计 1340 / 2000 千卡");
  assert.equal(lines[2], "蛋白还差 55g · 脂肪还差 20g · 碳水超 30g");
  assert.equal(nutritionLines(null, sumMacros([]), DEFAULT_TARGETS)[0], "今天累计 0 / 2000 千卡");
  assert.ok(targetsLine(DEFAULT_TARGETS).includes("2000 千卡"));
});
