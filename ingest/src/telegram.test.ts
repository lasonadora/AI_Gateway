import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, reportMessages, recordReply, esc, quotesLine } from "./telegram.ts";
import { summarize } from "./report.ts";
import type { Quote } from "./brief.ts";

test("parseCommand：命令、参数、@bot 后缀、非命令", () => {
  assert.deepEqual(parseCommand("/pair abc123"), { name: "pair", arg: "abc123" });
  assert.deepEqual(parseCommand("/report@health_bot"), { name: "report", arg: "" });
  assert.deepEqual(parseCommand("/whatever"), { name: "help", arg: "" });
  assert.equal(parseCommand("两个包子"), null);
  assert.equal(parseCommand(undefined), null);
});

test("reportMessages：HTML 转义、链接、长度", () => {
  const s = summarize([], "2026-11-19", "21:30");
  const n = { summary: "A<B & C", observations: ["观察"], suggestion: "建议", from_model: true };
  const q: Quote = { symbol: "TSLA", name: null, currency: "USD", last: 383.72, prev: 380, change_pct: 1.0, session_date: "2026-11-18", change_5d_pct: null, change_1m_pct: null, as_of: "x", as_of_epoch: 1, high_52w: null, low_52w: null };
  const brief = { market: "市场文字", news: [{ title: "标题", source: "BBC", url: "https://x/a?b=1&c=2", why: "原因" }], from_model: true };
  const msgs = reportMessages(s, n, brief, [q], "https://notion.so/p");
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].includes("A&lt;B &amp; C"));
  assert.ok(msgs[0].includes('<a href="https://x/a?b=1&amp;c=2">标题</a>'));
  assert.ok(msgs[0].includes("TSLA 383.72 +1.0%"));
  assert.ok(msgs[0].includes("Notion 完整报告"));
  assert.ok(!msgs[0].includes("均衡度"), "没饮食记录不显示均衡度");

  const long = { ...brief, market: "字".repeat(4000) };
  assert.equal(reportMessages(s, n, long, [q], null).length, 2);
});

test("recordReply / esc / quotesLine", () => {
  assert.equal(recordReply({ ok: true, message: "早餐 <x>", notion_url: "https://n" }), '早餐 &lt;x&gt;\n<a href="https://n">Notion</a>');
  assert.equal(esc("a&b"), "a&amp;b");
  const q: Quote = { symbol: "QQQ", name: null, currency: "USD", last: 659.51, prev: 659.51, change_pct: null, session_date: "2026-11-18", change_5d_pct: null, change_1m_pct: null, as_of: "x", as_of_epoch: 1, high_52w: null, low_52w: null };
  assert.equal(quotesLine([q]), "QQQ 659.51 —");
});
