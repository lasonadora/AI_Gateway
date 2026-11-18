import { test } from "node:test";
import assert from "node:assert/strict";
import { mealSlot, localTime, parseAnalysis, notionType, iconFor } from "./photo.ts";

test("mealSlot：按本地时间分餐次", () => {
  assert.equal(mealSlot(7, 30), "早餐");
  assert.equal(mealSlot(10, 29), "早餐");
  assert.equal(mealSlot(12, 0), "午餐");
  assert.equal(mealSlot(15, 0), "加餐");
  assert.equal(mealSlot(19, 0), "晚餐");
  assert.equal(mealSlot(21, 30), "夜宵");
  assert.equal(mealSlot(2, 0), "夜宵");
});

test("localTime：上海时区的 ISO 带 +08:00", () => {
  const t = localTime(new Date("2026-11-18T10:43:05Z"), "Asia/Shanghai");
  assert.equal(t.iso, "2026-11-18T18:43:05+08:00");
  assert.equal(t.hour, 18);
  assert.equal(t.minute, 43);
  assert.equal(t.ymd, "2026-11-18");
});

test("localTime：UTC 时区", () => {
  const t = localTime(new Date("2026-11-18T00:05:00Z"), "UTC");
  assert.equal(t.iso, "2026-11-18T00:05:00+00:00");
});

test("parseAnalysis：饭，过滤不合法类别，截断标题", () => {
  const a = parseAnalysis(`\`\`\`json
  {"kind":"meal","title":"牛肉面 + 青菜","items":["牛肉面","青菜"],"categories":["主食","蛋白","蔬菜","垃圾"],
   "portion":"大","calorie_band":"重","bristol":null,"flags":["大份","瞎编"],"confidence":0.82,"notes":"一大碗面。","red_flag":false}
  \`\`\``);
  assert.equal(a.kind, "meal");
  assert.deepEqual(a.categories, ["主食", "蛋白", "蔬菜"]);
  assert.deepEqual(a.flags, ["大份"]); // 模型给的「大份」「瞎编」都丢掉，份量为大时由代码补「大份」
  assert.equal(a.portion, "大");
  assert.equal(a.calorie_band, "重");
  assert.equal(a.bristol, null);
  assert.equal(a.confidence, 0.82);
  assert.equal(notionType(a.kind), "饮食");
});

test("parseAnalysis：排便，Bristol 取整夹到 1-7，自动补腹泻/便秘，带血 → red_flag", () => {
  const a = parseAnalysis(`{"kind":"stool","title":"排便","items":[],"categories":["主食"],"portion":"中","calorie_band":null,
    "bristol":6.6,"flags":["带血"],"confidence":0.7,"notes":"偏稀，可见红色。","red_flag":false}`);
  assert.equal(a.kind, "stool");
  assert.equal(a.bristol, 7);
  assert.deepEqual(a.categories, []); // 排便不该有食物类别
  assert.equal(a.portion, null);
  assert.ok(a.flags.includes("带血"));
  assert.ok(a.flags.includes("腹泻"));
  assert.equal(a.red_flag, true);
  assert.equal(notionType(a.kind), "排便");

  const b = parseAnalysis(`{"kind":"stool","title":"排便","bristol":1,"flags":[],"confidence":0.9,"notes":"","red_flag":false}`);
  assert.deepEqual(b.flags, ["便秘"]);
  assert.equal(b.red_flag, false);
});

test("parseAnalysis：夜宵由代码决定，模型给的夜宵丢掉", () => {
  const a = parseAnalysis(`{"kind":"meal","title":"面","items":["面"],"categories":["主食"],"portion":"中","flags":["夜宵"],"confidence":0.8,"notes":"","red_flag":false}`);
  assert.deepEqual(a.flags, []);
});

test("notionType / iconFor：饮品按咖啡因、酒精分类", () => {
  assert.equal(notionType("drink", ["咖啡因"]), "咖啡因");
  assert.equal(notionType("drink", ["酒精", "糖饮"]), "酒精");
  assert.equal(notionType("drink", ["糖饮"]), "饮食");
  assert.equal(notionType("meal", ["酒精"]), "饮食");
  assert.equal(notionType("stool"), "排便");
  assert.equal(iconFor("stool"), "🚽");
});

test("parseAnalysis：其他 / 坏输出", () => {
  const a = parseAnalysis(`前面有废话 {"kind":"other","title":"","confidence":2} 后面也有`);
  assert.equal(a.kind, "other");
  assert.equal(a.title, "未识别");
  assert.equal(a.confidence, 1);
  assert.throws(() => parseAnalysis("没有 json"));
  const b = parseAnalysis(`{"kind":"火星","confidence":"高"}`);
  assert.equal(b.kind, "other");
  assert.equal(b.confidence, 0.5);
});
