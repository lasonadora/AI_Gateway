import { test } from "node:test";
import assert from "node:assert/strict";
import { fromNotionPage, dayWindow, summarize, anomaliesOf, parseNarrative, pushText, reportBlocks, reportProps, type LogEntry } from "./report.ts";

const TZ = "Asia/Shanghai";

function entry(over: Partial<LogEntry>): LogEntry {
  return {
    id: "p1",
    url: null,
    iso: "2026-11-18T12:10:00+08:00",
    hm: "12:10",
    type: "饮食",
    title: "午饭",
    items: [],
    meal: "午餐",
    categories: [],
    portion: "中",
    calorie_band: "中",
    bristol: null,
    flags: [],
    confidence: 0.8,
    ...over,
  };
}

test("fromNotionPage：把 Notion 页压成 LogEntry，缺字段不炸", () => {
  const page = {
    id: "abc",
    url: "https://notion.so/abc",
    properties: {
      text: { title: [{ plain_text: "牛肉面 + 青菜" }] },
      datetime: { date: { start: "2026-11-18T20:34:04+08:00" } },
      type: { select: { name: "饮食" } },
      meal: { select: { name: "晚餐" } },
      items: { rich_text: [{ plain_text: "牛肉面、青菜" }] },
      categories: { multi_select: [{ name: "主食" }, { name: "蛋白" }, { name: "蔬菜" }] },
      portion: { select: { name: "中" } },
      calorie_band: { select: { name: "中" } },
      flags: { multi_select: [] },
      confidence: { number: 0.7 },
    },
  };
  const e = fromNotionPage(page, TZ);
  assert.equal(e.hm, "20:34");
  assert.equal(e.meal, "晚餐");
  assert.deepEqual(e.items, ["牛肉面", "青菜"]);
  assert.deepEqual(e.categories, ["主食", "蛋白", "蔬菜"]);
  assert.equal(e.bristol, null);

  const bare = fromNotionPage({ id: "x", properties: {}, created_time: "2026-11-18T01:00:00.000Z" }, TZ);
  assert.equal(bare.type, "其他");
  assert.equal(bare.title, "（无标题）");
  assert.equal(bare.hm, "09:00");
});

test("dayWindow：上海一天的起止带 +08:00", () => {
  assert.deepEqual(dayWindow("2026-11-18", TZ), { start: "2026-11-18T00:00:00+08:00", end: "2026-11-18T23:59:59+08:00" });
  assert.deepEqual(dayWindow("2026-11-18", "UTC"), { start: "2026-11-18T00:00:00+00:00", end: "2026-11-18T23:59:59+00:00" });
});

test("summarize：正餐去重、五大类覆盖、均衡度、标记并集", () => {
  const s = summarize(
    [
      entry({ id: "a", iso: "2026-11-18T08:00:00+08:00", hm: "08:00", meal: "早餐", categories: ["主食", "乳制品"] }),
      entry({ id: "b", iso: "2026-11-18T12:00:00+08:00", hm: "12:00", meal: "午餐", categories: ["主食", "蛋白", "蔬菜"] }),
      entry({ id: "c", iso: "2026-11-18T12:20:00+08:00", hm: "12:20", meal: "午餐", categories: ["蔬菜"] }), // 同一顿的第二张
      entry({ id: "d", iso: "2026-11-18T22:00:00+08:00", hm: "22:00", meal: "夜宵", categories: ["零食", "糖饮"], flags: ["夜宵"], portion: "大" }),
      entry({ id: "e", iso: "2026-11-18T07:30:00+08:00", hm: "07:30", type: "排便", meal: null, bristol: 4, portion: null, calorie_band: null }),
      entry({ id: "f", iso: "2026-11-18T15:00:00+08:00", hm: "15:00", type: "症状", meal: null, title: "头有点晕", portion: null, calorie_band: null }),
    ],
    "2026-11-18",
    "21:30",
  );
  assert.deepEqual(s.meals_eaten, ["早餐", "午餐"]);
  assert.deepEqual(s.meals_missing, ["晚餐"]);
  assert.equal(s.late_night, 1);
  assert.equal(s.snacks, 0);
  assert.deepEqual(s.covered, ["主食", "蛋白", "蔬菜", "乳制品"]);
  assert.deepEqual(s.missing_groups, ["水果"]);
  assert.equal(s.balance_score, 80);
  assert.equal(s.categories["蔬菜"], 2);
  assert.deepEqual(s.bristol, [4]);
  assert.deepEqual(s.flags, ["夜宵"]);
  assert.equal(s.red_flag, false);
  assert.equal(s.others.length, 1);
  assert.equal(s.entries[0].id, "e"); // 按时间排序
  assert.ok(s.anomalies.includes("没有晚餐记录"));
  assert.ok(s.anomalies.includes("夜宵 1 次"));
  assert.ok(s.anomalies.includes("糖饮 1 次"));
});

test("summarize：没饮食记录时均衡度为 null，也不报漏餐", () => {
  const s = summarize([entry({ type: "排便", meal: null, bristol: 7, flags: ["腹泻"], portion: null, calorie_band: null })], "2026-11-18", "21:30");
  assert.equal(s.balance_score, null);
  assert.deepEqual(s.meals_missing, []);
  assert.ok(s.anomalies.includes("排便偏稀（Bristol 7）"));
});

test("anomaliesOf：红旗、便秘、无蔬菜、咖啡因阈值", () => {
  const base = summarize(
    [
      entry({ id: "a", meal: "早餐", categories: ["主食", "咖啡因"], iso: "2026-11-18T08:00:00+08:00" }),
      entry({ id: "b", meal: "午餐", categories: ["主食", "蛋白", "咖啡因"], iso: "2026-11-18T12:00:00+08:00" }),
      entry({ id: "c", meal: "加餐", categories: ["咖啡因"], iso: "2026-11-18T15:00:00+08:00" }),
      entry({ id: "d", type: "排便", meal: null, bristol: 1, flags: ["便秘", "黑便"], iso: "2026-11-18T07:00:00+08:00", portion: null, calorie_band: null }),
    ],
    "2026-11-18",
    "13:00",
  );
  const a = anomaliesOf(base);
  assert.equal(a[0], "排便带血或黑便 → 建议尽快就医");
  assert.ok(a.includes("排便偏干（Bristol 1）"));
  assert.ok(a.includes("咖啡因 3 次"));
  assert.ok(a.includes("一天没有蔬菜"));
  assert.ok(!a.some((x) => x.startsWith("没有")), "13:00 时晚餐还没到，不算漏");
  assert.equal(base.red_flag, true);
});

test("parseNarrative：正常 JSON、带代码块、坏输出兜底", () => {
  const s = summarize([entry({ categories: ["主食"] })], "2026-11-18");
  const ok = parseNarrative('{"summary":"吃得偏主食","observations":["午餐只有面","没有蔬菜水果"],"suggestion":"明天加一份蔬菜"}', s);
  assert.equal(ok.from_model, true);
  assert.equal(ok.summary, "吃得偏主食");
  assert.equal(ok.observations.length, 2);

  const fenced = parseNarrative('```json\n{"summary":"ok","observations":["x"],"suggestion":"y"}\n```', s);
  assert.equal(fenced.suggestion, "y");

  const bad = parseNarrative("今天吃得不错！", s);
  assert.equal(bad.from_model, false);
  assert.ok(bad.summary.includes("1 顿正餐"));
  assert.ok(bad.suggestion.includes("蛋白"));
});

test("pushText / reportProps / reportBlocks：输出形状", () => {
  const s = summarize(
    [entry({ id: "a", categories: ["主食", "蔬菜"] }), entry({ id: "b", type: "排便", meal: null, bristol: 4, iso: "2026-11-18T07:00:00+08:00", portion: null, calorie_band: null })],
    "2026-11-18",
    "21:30",
  );
  const n = parseNarrative('{"summary":"一句话","observations":["观察一"],"suggestion":"建议一"}', s);
  const push = pushText(s, n);
  assert.equal(push.title, "日报 11/18 · 均衡度 40");
  assert.equal(push.body, "一句话\n明天：建议一");

  const props = reportProps(s, n, "claude-sonnet-5-5");
  assert.equal(props.date.title[0].text.content, "2026-11-18");
  assert.equal(props.type.select.name, "日报");
  assert.equal(props.status_score.number, 40);
  assert.equal(props.meals.number, 1);
  assert.equal(props.stools.number, 1);
  assert.equal(props.flags, undefined);
  assert.ok(props.raw_json.rich_text[0].text.content.length <= 1900);

  const blocks = reportBlocks(s, n, "claude-sonnet-5-5");
  const headings = blocks.filter((b) => b.type === "heading_2").map((b) => b.heading_2.rich_text[0].text.content);
  assert.deepEqual(headings, ["一句话", "今天吃了什么", "排便", "统计", "点评", "明天试试"]);
  const mentions = blocks.flatMap((b) => b[b.type].rich_text ?? []).filter((r: any) => r.type === "mention");
  assert.equal(mentions.length, 2, "每条记录一个页面 mention");
  assert.ok(!blocks.some((b) => b.type === "callout" && b.callout.color === "red_background"));
});
