// Telegram 健康记录 bot 的纯逻辑：命令解析、消息排版（HTML）。网络和状态在 index.ts。
import type { DayStats, Narrative } from "./report.ts";
import type { Brief, Quote } from "./brief.ts";
import { fmtPct } from "./brief.ts";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type Command = { name: "start" | "help" | "pair" | "report" | "unpair"; arg: string } | null;

/** "/pair abc" → {name:"pair", arg:"abc"}；"/report@my_bot" 也认；不是命令返回 null。 */
export function parseCommand(text: string | undefined): Command {
  if (!text) return null;
  const m = text.trim().match(/^\/([a-zA-Z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const arg = (m[2] ?? "").trim();
  if (name === "start" || name === "help" || name === "pair" || name === "report" || name === "unpair") return { name, arg };
  return { name: "help", arg: "" };
}

export const HELP_TEXT = [
  "这是你的健康记录 bot。",
  "• 直接发<b>照片</b>：饭、饮品、排便都行，我识别后写进 Notion「记录」并回你结果。照片说明文字会一起记。",
  "• 直接发<b>文字</b>：比如「两个包子一杯豆浆」，也会记。",
  "• /report  现在生成今天的日报并发到这里",
  "• /pair &lt;INGEST_TOKEN&gt;  配对（第一次用）",
  "• /unpair  取消这个对话的配对",
  "每天 21:30 日报会自动发到这里。",
].join("\n");

export const PAIR_HINT = "还没配对。发 <code>/pair 你的INGEST_TOKEN</code>（和快捷指令里那串一样）。";

const bulletList = (items: string[]) => items.map((o) => `• ${esc(o)}`).join("\n");

export function quotesLine(quotes: Quote[]): string {
  return quotes.map((q) => `${q.symbol} ${q.last} ${fmtPct(q.change_pct)}`).join(" · ");
}

/** 日报在 Telegram 里的样子。返回 1–2 条消息（Telegram 单条上限 4096）。 */
export function reportMessages(s: DayStats, n: Narrative, brief: Brief | null, quotes: Quote[], notionUrl: string | null): string[] {
  const md = s.date.slice(5).replace("-", "/");
  const head: string[] = [];
  head.push(`📋 <b>日报 ${md}</b>${s.balance_score === null ? "" : ` · 均衡度 ${s.balance_score}/100`}`);
  head.push(esc(n.summary));
  if (n.observations.length) head.push(bulletList(n.observations));
  if (n.suggestion) head.push(`明天：${esc(n.suggestion)}`);
  if (s.anomalies.length) head.push(`${s.red_flag ? "⚠️ " : ""}异常：${esc(s.anomalies.join("；"))}`);
  if (s.red_flag) head.push("⚠️ 记录里有带血/黑便标记，建议尽快就医（不是诊断）。");

  const parts: string[] = [];
  if (brief) {
    const m: string[] = [];
    m.push(`📈 <b>市场</b>${quotes.length ? `（交易日 ${esc(quotes[0].session_date)}）` : ""}`);
    if (quotes.length) m.push(`<code>${esc(quotesLine(quotes))}</code>`);
    m.push(esc(brief.market));
    parts.push(m.join("\n"));

    const news: string[] = ["📰 <b>今天最值得看的 3 条</b>"];
    if (brief.news.length) {
      brief.news.forEach((x, i) => {
        const title = x.url ? `<a href="${esc(x.url)}">${esc(x.title)}</a>` : esc(x.title);
        news.push(`${i + 1}. ${title}${x.source ? `（${esc(x.source)}）` : ""}${x.why ? ` — ${esc(x.why)}` : ""}`);
      });
    } else news.push("今天新闻源没取到。");
    parts.push(news.join("\n"));
  }
  if (notionUrl) parts.push(`<a href="${esc(notionUrl)}">Notion 完整报告</a>`);

  const first = head.join("\n");
  const rest = parts.join("\n\n");
  const all = `${first}\n\n${rest}`;
  return all.length <= 3900 ? [all] : [first, rest.slice(0, 3900)];
}

/** 一张照片 / 一段文字记录后的回复。 */
export function recordReply(r: { ok: boolean; message: string; notion_url?: string | null; red_flag?: boolean }): string {
  const lines = [esc(r.message)];
  if (r.notion_url) lines.push(`<a href="${esc(r.notion_url)}">Notion</a>`);
  return lines.join("\n");
}
