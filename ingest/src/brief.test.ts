import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteFromCloses, parseYahooChart, parseStooqCsv, parseCnbcQuotes, updateHistory, changesFromHistory, parseRss, dedupeNews, parseBrief, clampChinese, fallbackMarket, briefBlocks, briefProps, briefUserPrompt, type Quote, type NewsItem } from "./brief.ts";

test("quoteFromCloses：涨跌、5 日、1 月", () => {
  const closes = Array.from({ length: 25 }, (_, i) => 100 + i); // 100..124
  const q = quoteFromCloses("TSLA", closes, { epoch: 1763499600 })!; // 2025-11-18 16:00 ET
  assert.equal(q.last, 124);
  assert.equal(q.prev, 123);
  assert.equal(q.change_pct, 0.8);
  assert.equal(q.change_5d_pct, 4.2); // 124 vs 119
  assert.equal(q.change_1m_pct, 20.4); // 124 vs 103
  assert.ok(q.as_of.endsWith("ET"));
  assert.equal(quoteFromCloses("X", [null, 5]), null);
});

test("parseYahooChart：以 meta 的实时价为准，null 收盘被忽略", () => {
  const json = {
    chart: {
      result: [
        {
          meta: { symbol: "QQQ", currency: "USD", regularMarketPrice: 510.5, regularMarketTime: 1763499600, fiftyTwoWeekHigh: 520, fiftyTwoWeekLow: 400, shortName: "Invesco QQQ" },
          timestamp: [1, 2, 3, 4],
          indicators: { quote: [{ close: [500, null, 505, 510] }] },
        },
      ],
    },
  };
  const q = parseYahooChart(json)!;
  assert.equal(q.symbol, "QQQ");
  assert.equal(q.last, 510.5);
  assert.equal(q.prev, 505);
  assert.equal(q.change_pct, 1.1);
  assert.equal(q.change_5d_pct, null);
  assert.equal(q.high_52w, 520);
  assert.equal(parseYahooChart({ chart: { result: null } }), null);
});

test("parseStooqCsv：备胎 CSV", () => {
  const csv = "Date,Open,High,Low,Close,Volume\n2026-11-14,1,1,1,100,10\n2026-11-17,1,1,1,110,10\n2026-11-18,1,1,1,99,10\n";
  const q = parseStooqCsv("ASML", csv)!;
  assert.equal(q.last, 99);
  assert.equal(q.change_pct, -10);
  assert.equal(q.as_of, "11-18 16:00 ET");
});

test("parseRss：Google News 风格（source 标签、HTML 实体、CDATA）", () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>Top</title>
  <item><title><![CDATA[Fed holds rates &amp; signals patience - Reuters]]></title><link>https://example.com/a</link><pubDate>Wed, 18 Nov 2026 12:00:00 GMT</pubDate><source url="https://reuters.com">Reuters</source><description>&lt;p&gt;Body &amp;amp; more&lt;/p&gt;</description></item>
  <item><title>Second &#39;story&#39;</title><link>https://example.com/b</link><pubDate>Wed, 18 Nov 2026 13:00:00 GMT</pubDate></item>
  <item><title></title><link>https://example.com/empty</link></item>
  </channel></rss>`;
  const items = parseRss(xml, "Google News");
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Fed holds rates & signals patience - Reuters");
  assert.equal(items[0].source, "Reuters");
  assert.equal(items[0].published, "2026-11-18T12:00:00.000Z");
  assert.equal(items[0].description, "Body & more");
  assert.equal(items[1].title, "Second 'story'");
  assert.equal(items[1].source, "Google News");
  const top = dedupeNews([...items, { ...items[0], link: "https://dup" }], 5);
  assert.equal(top.length, 2);
  assert.equal(top[0].link, "https://example.com/b", "新的在前");
});

test("clampChinese / parseBrief：字数上限、编号映射到链接、坏输出兜底", () => {
  const long = "一".repeat(300) + "。" + "二".repeat(300) + "。";
  const c = clampChinese(long, 500);
  assert.ok([...c].length <= 500);
  assert.ok(c.endsWith("。"));

  const world: NewsItem[] = [
    { title: "A", link: "https://ok/1", source: "BBC", published: null, description: "" },
    { title: "B", link: "https://ok/2", source: "Reuters", published: null, description: "" },
  ];
  const good = parseBrief('{"market":"TSLA 涨了。","news":[{"id":2,"title":"乙","why":"大"},{"id":2,"title":"重复","why":"x"},{"id":9,"title":"编号不存在","why":"小"}]}', world, 500, "fb");
  assert.equal(good.from_model, true);
  assert.equal(good.news[0].url, "https://ok/2");
  assert.equal(good.news[0].source, "Reuters");
  assert.equal(good.news[1].url, null, "重复编号不再给链接");
  assert.equal(good.news[2].url, null, "编号越界丢掉链接");

  const bad = parseBrief("今天市场不错", world, 500, "TSLA 1 +1.0%。");
  assert.equal(bad.from_model, false);
  assert.equal(bad.market, "TSLA 1 +1.0%。");
  assert.deepEqual(bad.news, []);
});

test("parseCnbcQuotes + 本地历史：带逗号的字符串、盘前、5 日/1 月", () => {
  const json = {
    FormattedQuoteResult: {
      FormattedQuote: [
        {
          symbol: "SPCX",
          name: "Space Exploration Technologies Corp",
          last: "1,234.56",
          previous_day_closing: "1,200.00",
          change_pct: "2.88",
          last_time: "2026-11-18T16:00:00.000-0500",
          yrhiprice: "1,300.00",
          yrloprice: "150.00",
          ExtendedMktQuote: { type: "PRE_MKT", last: "1,240.10", change_pct: "0.45" },
        },
        { symbol: "BAD", last: "N/A", previous_day_closing: "1" },
      ],
    },
  };
  const hist = { SPCX: Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, close: 1000 + i * 10 })) };
  const { quotes, extended } = parseCnbcQuotes(json, hist);
  assert.equal(quotes.length, 1);
  const q = quotes[0];
  assert.equal(q.last, 1234.56);
  assert.equal(q.prev, 1200);
  assert.equal(q.change_pct, 2.88);
  assert.equal(q.as_of, "11-18 16:00 ET");
  assert.equal(q.high_52w, 1300);
  assert.equal(q.change_5d_pct, -1.2); // vs 2026-10-26 close 1250
  assert.equal(q.change_1m_pct, 13.3); // vs 2026-10-10 close 1090
  assert.equal(extended.SPCX, "盘前 1240.1 +0.5%");

  const h2 = updateHistory(hist, quotes);
  assert.equal(h2.SPCX[h2.SPCX.length - 1].date, "2026-11-18");
  assert.equal(h2.SPCX[h2.SPCX.length - 1].close, 1234.56);
  assert.equal(updateHistory(h2, quotes).SPCX.length, h2.SPCX.length, "同一天不重复记");
  assert.deepEqual(changesFromHistory(10, "2026-11-18", undefined), { d5: null, m1: null });
});

test("fallbackMarket / blocks / props / prompt 形状", () => {
  const q: Quote = { symbol: "TSLA", name: "Tesla", currency: "USD", last: 412.3, prev: 417.1, change_pct: -1.2, change_5d_pct: 3.4, change_1m_pct: -5, as_of: "11-18 16:00 ET", as_of_epoch: 1, high_52w: 500, low_52w: 200 };
  assert.equal(fallbackMarket([q], ["SPCX"]), "TSLA 412.3 -1.2%；行情暂缺：SPCX。");
  const brief = { market: "第一段。\n第二段。", news: [{ title: "标题", source: "BBC", url: "https://x", why: "原因" }], from_model: true };
  const blocks = briefBlocks(brief, [q], ["TSLA", "SPCX"]);
  const types = blocks.map((b) => b.type);
  assert.equal(types.filter((t) => t === "heading_2").length, 2);
  assert.equal(types.filter((t) => t === "numbered_list_item").length, 1);
  assert.ok(blocks.some((b) => b.type === "paragraph" && b.paragraph.rich_text[0].text.content.includes("TSLA 412.3 -1.2%（5日 +3.4% · 1月 -5.0%）")));
  const link = blocks.find((b) => b.type === "numbered_list_item").numbered_list_item.rich_text[1];
  assert.equal(link.text.link.url, "https://x");
  const props = briefProps(brief);
  assert.equal(props.news.rich_text[0].text.content, "1. 【BBC】标题 — 原因");
  const prompt = briefUserPrompt("2026-11-19", [q], { TSLA: [] }, [{ title: "t", link: "https://x", source: "BBC", published: null, description: "" }], ["SPCX"], { TSLA: "盘前 413 +0.2%" });
  assert.ok(prompt.includes("行情暂缺") && prompt.includes("[1] t | BBC") && prompt.includes("盘前 413") && !prompt.includes("https://x"), "链接不进提示词，用编号");
});
