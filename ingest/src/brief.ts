// 日报里的"市场 + 新闻"部分的纯逻辑：解析行情 JSON / CSV、解析 RSS、拼提示词、校验模型输出、生成 Notion 块。
// 数字（价格、涨跌幅）全由代码算；模型只写 ≤500 字的分析和挑 3 条新闻。不碰网络，方便 node:test。

export const DEFAULT_TICKERS = ["TSLA", "SPCX", "ASML", "QQQ"];

export interface Quote {
  symbol: string;
  name: string | null;
  currency: string;
  last: number; // 最新（盘中为实时，盘前/盘后为上一收盘）
  prev: number; // 上一个收盘
  change_pct: number; // last 相对 prev
  change_5d_pct: number | null;
  change_1m_pct: number | null;
  as_of: string; // 本地（纽约）时间字符串，如 "11-18 16:00 ET"
  as_of_epoch: number;
  high_52w: number | null;
  low_52w: number | null;
}

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  published: string | null; // ISO
  description: string;
}

export interface Brief {
  market: string; // ≤ maxChars
  news: Array<{ title: string; source: string; url: string | null; why: string }>;
  from_model: boolean;
}

const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 1000) / 10 : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

export function nyTime(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const g = (t: string) => f.formatToParts(d).find((p) => p.type === t)?.value ?? "";
  return `${g("month")}-${g("day")} ${g("hour")}:${g("minute")} ET`;
}

/** 从一串日线收盘价（旧→新）算出 Quote 的涨跌。closes 里可能有 null（停牌日），先滤掉。 */
export function quoteFromCloses(symbol: string, rawCloses: Array<number | null>, meta: { name?: string | null; currency?: string; epoch?: number; high52?: number | null; low52?: number | null } = {}): Quote | null {
  const closes = rawCloses.filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  if (closes.length < 2) return null;
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const back = (n: number) => (closes.length > n ? closes[closes.length - 1 - n] : null);
  const c5 = back(5);
  const c21 = back(21) ?? (closes.length >= 15 ? closes[0] : null);
  const epoch = meta.epoch ?? Math.floor(Date.now() / 1000);
  return {
    symbol,
    name: meta.name ?? null,
    currency: meta.currency ?? "USD",
    last: r2(last),
    prev: r2(prev),
    change_pct: pct(last, prev),
    change_5d_pct: c5 ? pct(last, c5) : null,
    change_1m_pct: c21 ? pct(last, c21) : null,
    as_of: nyTime(epoch),
    as_of_epoch: epoch,
    high_52w: meta.high52 ?? null,
    low_52w: meta.low52 ?? null,
  };
}

/** Yahoo Finance v8 chart 接口（range=1mo&interval=1d）。 */
export function parseYahooChart(json: any): Quote | null {
  const r = json?.chart?.result?.[0];
  if (!r) return null;
  const meta = r.meta ?? {};
  const closes: Array<number | null> = r.indicators?.quote?.[0]?.close ?? [];
  // 盘中时最后一个点是实时价；盘前盘后则是上一收盘。两种情况 closes[-1] vs closes[-2] 都正确。
  const q = quoteFromCloses(meta.symbol ?? "?", closes, {
    name: meta.longName ?? meta.shortName ?? null,
    currency: meta.currency ?? "USD",
    epoch: typeof meta.regularMarketTime === "number" ? meta.regularMarketTime : undefined,
    high52: typeof meta.fiftyTwoWeekHigh === "number" ? meta.fiftyTwoWeekHigh : null,
    low52: typeof meta.fiftyTwoWeekLow === "number" ? meta.fiftyTwoWeekLow : null,
  });
  if (q && typeof meta.regularMarketPrice === "number" && closes.length) {
    // Yahoo 盘中 closes[-1] 可能比 meta 旧几分钟，以 meta 为准
    q.last = r2(meta.regularMarketPrice);
    q.change_pct = pct(q.last, q.prev);
  }
  return q;
}

/** Stooq 日线 CSV（Date,Open,High,Low,Close,Volume），作为 Yahoo 的备胎。 */
export function parseStooqCsv(symbol: string, csv: string): Quote | null {
  const lines = csv.trim().split(/\r?\n/).slice(1);
  const rows = lines.map((l) => l.split(",")).filter((c) => c.length >= 5 && !Number.isNaN(Number(c[4])));
  if (!rows.length) return null;
  const closes = rows.map((c) => Number(c[4]));
  const lastDate = rows[rows.length - 1][0]; // YYYY-MM-DD
  const epoch = Math.floor(new Date(`${lastDate}T21:00:00Z`).getTime() / 1000); // 收盘 16:00 ET ≈ 21:00Z（冬令时）
  return quoteFromCloses(symbol, closes, { epoch });
}

// ---------- RSS ----------

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
const stripCdata = (s: string) => s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? decodeEntities(stripCdata(m[1])).trim() : "";
};

/** 够用的 RSS 2.0 / Atom 解析：只取 title / link / pubDate / source / description。 */
export function parseRss(xml: string, defaultSource: string): NewsItem[] {
  const chunks = xml.split(/<(?:item|entry)[\s>]/i).slice(1);
  const out: NewsItem[] = [];
  for (const c of chunks) {
    // RSS 里的 title/description 常是"转义过的 HTML"，解一次实体 → 去标签 → 再解一次
    const title = decodeEntities(stripTags(tag(c, "title")));
    if (!title) continue;
    let link = tag(c, "link");
    if (!link) {
      const m = c.match(/<link[^>]*href="([^"]+)"/i);
      link = m ? decodeEntities(m[1]) : "";
    }
    const srcMatch = c.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const source = srcMatch ? stripTags(decodeEntities(stripCdata(srcMatch[1]))) || defaultSource : defaultSource;
    const pub = tag(c, "pubDate") || tag(c, "published") || tag(c, "updated") || tag(c, "dc:date");
    const published = pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub).toISOString() : null;
    out.push({ title, link, source, published, description: decodeEntities(stripTags(tag(c, "description"))).slice(0, 300) });
  }
  return out;
}

/** 去重（标题前 40 字相同算同一条）、按时间新→旧、最多 n 条。 */
export function dedupeNews(items: NewsItem[], n: number): NewsItem[] {
  const seen = new Set<string>();
  const sorted = [...items].sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
  const out: NewsItem[] = [];
  for (const it of sorted) {
    const key = it.title.toLowerCase().replace(/\s+/g, " ").slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= n) break;
  }
  return out;
}

// ---------- 给模型 ----------

export const BRIEF_SYSTEM_PROMPT = `你在给一位个人投资者写每日简报的两个小节，中文，口语但干净。
【市场】只能基于给你的行情数字和新闻标题写，不要编造数字、不要预测价格、不要给买卖建议（不说"建议买入/卖出/加仓/减仓"）。
格式：每个标的一行（标的 · 涨跌 · 一句话原因，原因只能来自提供的新闻或"没有明显消息"），最后 1–2 句整体观察（比如和 QQQ 的相对表现、共同驱动因素、接下来要盯的日期）。全部加起来不超过 {MAX} 个汉字。如果数据注明不是今天的收盘（周末/假期），开头先说明一句。
【新闻】从给你的世界新闻标题里挑最值得关注的 3 条，按"对世界的影响"从大到小排（地缘冲突、重大经济/政策变化、影响大量人口的事件 > 单个公司/名人 > 体育娱乐）。同一事件只算一条。每条给中文标题和一句"为什么重要"（≤40 字）。url 必须原样来自提供的列表。
只输出一个 JSON 对象，不要 markdown 代码块、不要别的文字：
{"market": "……", "news": [{"title": "中文标题", "source": "来源", "url": "原链接", "why": "为什么重要"}, …3 条]}`;

export function briefUserPrompt(date: string, quotes: Quote[], tickerNews: Record<string, NewsItem[]>, worldNews: NewsItem[], failed: string[]): string {
  const q = quotes.map((x) => ({
    symbol: x.symbol,
    name: x.name,
    last: x.last,
    change_pct: x.change_pct,
    change_5d_pct: x.change_5d_pct,
    change_1m_pct: x.change_1m_pct,
    as_of: x.as_of,
    high_52w: x.high_52w,
    low_52w: x.low_52w,
  }));
  const tn: Record<string, string[]> = {};
  for (const [s, items] of Object.entries(tickerNews)) tn[s] = items.map((i) => `${i.title} (${i.source}${i.published ? ", " + i.published.slice(0, 16) + "Z" : ""})`);
  const wn = worldNews.map((i, k) => `${k + 1}. ${i.title} | ${i.source} | ${i.published ? i.published.slice(0, 16) + "Z" : "?"} | ${i.link}`);
  return [
    `日期：${date}（北京时间）。`,
    failed.length ? `这些标的行情没取到，直接写"行情暂缺"：${failed.join(", ")}` : "",
    `行情（代码算好的，as_of 是纽约时间）：\n${JSON.stringify(q)}`,
    `各标的最近新闻标题：\n${JSON.stringify(tn)}`,
    `世界新闻（标题 | 来源 | 时间 | 链接）：\n${wn.join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** 在 max 字以内按句号截断。 */
export function clampChinese(s: string, max: number): string {
  const t = s.trim();
  if ([...t].length <= max) return t;
  const chars = [...t].slice(0, max);
  const cut = chars.join("");
  const idx = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf("\n"));
  return (idx > max * 0.5 ? cut.slice(0, idx + 1) : cut).trim();
}

export function parseBrief(raw: string, allowedUrls: Set<string>, maxChars: number, fallbackMarket: string): Brief {
  try {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const o = JSON.parse(text);
    const market = typeof o.market === "string" && o.market.trim() ? clampChinese(o.market, maxChars) : fallbackMarket;
    const news = Array.isArray(o.news)
      ? o.news
          .filter((n: any) => n && typeof n.title === "string" && n.title.trim())
          .slice(0, 3)
          .map((n: any) => ({
            title: String(n.title).trim().slice(0, 120),
            source: typeof n.source === "string" ? n.source.trim().slice(0, 40) : "",
            url: typeof n.url === "string" && allowedUrls.has(n.url.trim()) ? n.url.trim() : null,
            why: typeof n.why === "string" ? n.why.trim().slice(0, 120) : "",
          }))
      : [];
    return { market, news, from_model: true };
  } catch {
    return { market: fallbackMarket, news: [], from_model: false };
  }
}

/** 模型挂了也有一行数字可看。 */
export function fallbackMarket(quotes: Quote[], failed: string[]): string {
  const lines = quotes.map((q) => `${q.symbol} ${q.last} ${fmtPct(q.change_pct)}`);
  if (failed.length) lines.push(`行情暂缺：${failed.join("、")}`);
  return lines.length ? lines.join("；") + "。" : "今天行情和新闻都没取到。";
}

export const fmtPct = (p: number | null) => (p === null ? "—" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`);

// ---------- Notion 块 ----------

const txt = (content: string, link?: string | null) => ({ type: "text", text: { content: content.slice(0, 1900), ...(link ? { link: { url: link } } : {}) } });
const block = (type: string, rich_text: any[], extra: Record<string, any> = {}) => ({ object: "block", type, [type]: { rich_text, ...extra } });

export function briefBlocks(brief: Brief, quotes: Quote[], tickers: string[]): any[] {
  const out: any[] = [];
  out.push(block("heading_2", [txt(`市场 · ${tickers.join(" / ")}`)]));
  if (quotes.length) {
    const line = quotes.map((q) => `${q.symbol} ${q.last} ${fmtPct(q.change_pct)}（5日 ${fmtPct(q.change_5d_pct)} · 1月 ${fmtPct(q.change_1m_pct)}）`).join("　");
    out.push(block("paragraph", [txt(line)], { color: "gray" }));
    out.push(block("paragraph", [txt(`数据截至 ${quotes[0].as_of}（纽约时间）`)], { color: "gray" }));
  }
  for (const para of brief.market.split(/\n+/).filter((p) => p.trim())) out.push(block("paragraph", [txt(para.trim())]));

  out.push(block("heading_2", [txt("今天最值得看的 3 条")]));
  if (brief.news.length) {
    for (const n of brief.news) {
      const rt: any[] = [];
      if (n.source) rt.push(txt(`【${n.source}】`));
      rt.push(txt(n.title, n.url));
      if (n.why) rt.push(txt(` — ${n.why}`));
      out.push(block("numbered_list_item", rt));
    }
  } else {
    out.push(block("paragraph", [txt("今天新闻源没取到。")]));
  }
  out.push(block("callout", [txt("行情和新闻来自公开源（Yahoo Finance / Google News / BBC），数字由程序计算，文字由模型生成；只是信息整理，不构成投资建议。")], { icon: { type: "emoji", emoji: "📈" }, color: "gray_background" }));
  return out;
}

export function briefProps(brief: Brief): Record<string, any> {
  const newsText = brief.news.map((n, i) => `${i + 1}. ${n.source ? `【${n.source}】` : ""}${n.title}${n.why ? ` — ${n.why}` : ""}`).join("\n");
  return {
    market: { rich_text: [txt(brief.market)] },
    news: { rich_text: [txt(newsText || "（无）")] },
  };
}
