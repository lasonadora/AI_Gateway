// 健康数据接收端（Hono + 官方 Notion SDK v5）。入口：
//   POST /ingest/hae         Health Auto Export 每小时推 Apple Health 数据 → Notion「每日指标」upsert（纯搬运，不调模型）
//   POST /ingest/photo       手机一键拍照 → 视觉模型识别（饭 / 饮品 / 排便） → 原图存盘 + Notion「记录」一行（附照片）
//   POST /ingest/report/run  手动跑某天日报（?date=YYYY-MM-DD&push=0）
//   GET  /ingest/report/latest 最近一份日报的摘要（给快捷指令用）
//   每天 REPORT_TIME（默认 21:30）自动跑当天日报 → Notion「报告」一行 + Bark 推送到手机（配了 BARK_KEY 才推）
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Client } from "@notionhq/client";
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

import { aggregate, type Daily } from "./hae.ts";
import { SYSTEM_PROMPT, userPrompt, parseAnalysis, mealSlot, localTime, notionType, iconFor, type Analysis } from "./photo.ts";
import { fromNotionPage, dayWindow, summarize, REPORT_SYSTEM_PROMPT, reportUserPrompt, parseNarrative, pushText, reportBlocks, reportProps, type DayStats, type Narrative } from "./report.ts";
import { DEFAULT_TICKERS, NEWS_QUERY, parseYahooChart, parseCnbcQuotes, updateHistory, parseRss, dedupeNews, BRIEF_SYSTEM_PROMPT, briefUserPrompt, parseBrief, fallbackMarket, briefBlocks, briefProps, type Quote, type NewsItem, type Brief, type History } from "./brief.ts";

const env = (k: string, required = true): string => {
  const v = process.env[k];
  if (!v && required) throw new Error(`缺少环境变量 ${k}`);
  return v ?? "";
};

const NOTION_TOKEN = env("NOTION_TOKEN");
const DAILY_DS = env("NOTION_DAILY_DATA_SOURCE_ID"); // 每日指标库
const LOG_DS = env("NOTION_LOG_DATA_SOURCE_ID"); // 记录库
const INGEST_TOKEN = env("INGEST_TOKEN"); // 手机/HAE 请求头里带的密码
const ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY");
const VISION_MODEL = process.env.VISION_MODEL || "claude-sonnet-5-5";
const REPORT_MODEL = process.env.REPORT_MODEL || VISION_MODEL;
const PHOTO_DIR = process.env.PHOTO_DIR || "/data/photos";
const TZ = process.env.TZ || "Asia/Shanghai";
const REPORT_DS = process.env.NOTION_REPORT_DATA_SOURCE_ID || ""; // 报告库；没配就不出日报
const REPORT_TIME = /^\d{2}:\d{2}$/.test(process.env.REPORT_TIME ?? "") ? (process.env.REPORT_TIME as string) : "21:30";
const BARK_KEY = process.env.BARK_KEY || ""; // iPhone 推送（Bark app 的 device key）；空 = 不推
const BARK_SERVER = (process.env.BARK_SERVER || "https://api.day.app").replace(/\/$/, "");
const STATE_FILE = join(PHOTO_DIR, "report-state.json");
// 日报里的市场 + 新闻小节：BRIEF_TICKERS 设成空字符串即关闭
const BRIEF_TICKERS = (process.env.BRIEF_TICKERS ?? DEFAULT_TICKERS.join(",")).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const BRIEF_MAX_CHARS = Number(process.env.BRIEF_MAX_CHARS) > 0 ? Number(process.env.BRIEF_MAX_CHARS) : 500;

const notion = new Client({ auth: NOTION_TOKEN, notionVersion: "2025-09-03" });
const app = new Hono();

const authed = (c: any) => (c.req.header("authorization") ?? "") === `Bearer ${INGEST_TOKEN}`;

// ---------- 文本模型（日报点评） ----------

async function askModel(system: string, user: string, maxTokens = 600): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: REPORT_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`模型调用失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
}

// ---------- 手机推送（Bark） ----------

async function pushPhone(title: string, body: string, url?: string | null, level: "active" | "timeSensitive" = "active"): Promise<boolean> {
  if (!BARK_KEY) return false;
  try {
    const res = await fetch(`${BARK_SERVER}/push`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ device_key: BARK_KEY, title, body, group: "健康", level, ...(url ? { url } : {}) }),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    return true;
  } catch (e: any) {
    console.error("[push] 失败", e?.message ?? e);
    return false;
  }
}

// ---------- 每日指标 upsert（Health Auto Export） ----------

function dailyProps(row: Daily) {
  const p: Record<string, any> = { date: { title: [{ text: { content: row.date } }] } };
  const n = (k: keyof Daily) => (row[k] !== undefined ? { number: row[k] } : undefined);
  const t = (k: keyof Daily) => (row[k] !== undefined ? { rich_text: [{ text: { content: String(row[k]) } }] } : undefined);
  const dt = (k: keyof Daily) => (row[k] !== undefined ? { date: { start: String(row[k]) } } : undefined);
  const set = (k: string, v: any) => v !== undefined && (p[k] = v);
  set("sleep_hours", n("sleep_hours"));
  set("hrv_ms", n("hrv_ms"));
  set("resting_hr", n("resting_hr"));
  set("spo2_min", n("spo2_min"));
  set("steps", n("steps"));
  set("active_min", n("active_min"));
  set("weight_kg", n("weight_kg"));
  set("workouts", t("workouts"));
  set("sleep_start", dt("sleep_start"));
  set("sleep_end", dt("sleep_end"));
  p.source = { select: { name: "HealthKit" } };
  p.synced_at = { date: { start: new Date().toISOString() } };
  return p;
}

async function upsertDaily(row: Daily): Promise<"created" | "updated"> {
  const found = await notion.dataSources.query({
    data_source_id: DAILY_DS,
    filter: { property: "date", title: { equals: row.date } },
    page_size: 1,
  } as any);
  const existing = (found as any).results?.[0];
  if (existing) {
    await notion.pages.update({ page_id: existing.id, properties: dailyProps(row) } as any);
    return "updated";
  }
  await notion.pages.create({ parent: { type: "data_source_id", data_source_id: DAILY_DS }, properties: dailyProps(row) } as any);
  return "created";
}

// ---------- 拍照：视觉模型 ----------

async function analyzePhoto(jpeg: Buffer, localIso: string, note?: string): Promise<{ analysis: Analysis; raw: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
            { type: "text", text: userPrompt(localIso, note) },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`模型调用失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  const raw = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  return { analysis: parseAnalysis(raw), raw };
}

// ---------- 拍照：Notion 写入 ----------

async function uploadToNotion(jpeg: Buffer, filename: string): Promise<string> {
  const created: any = await (notion as any).fileUploads.create({ mode: "single_part", filename, content_type: "image/jpeg" });
  await (notion as any).fileUploads.send({
    file_upload_id: created.id,
    file: { filename, data: new Blob([jpeg], { type: "image/jpeg" }) },
  });
  return created.id as string;
}

function logProps(a: Analysis, iso: string, meal: string | null, fileUploadId: string | null, filename: string) {
  const sel = (name: string | null) => (name ? { select: { name } } : undefined);
  const multi = (names: string[]) => (names.length ? { multi_select: names.map((name) => ({ name })) } : undefined);
  const p: Record<string, any> = {
    text: { title: [{ text: { content: a.title } }] },
    datetime: { date: { start: iso } },
    type: { select: { name: notionType(a.kind, a.categories) } },
    source: { select: { name: "手机拍照" } },
    confidence: { number: Math.round(a.confidence * 100) / 100 },
    agent_note: { rich_text: [{ text: { content: `${a.notes} [${VISION_MODEL}]`.slice(0, 1900) } }] },
  };
  if (a.items.length) p.items = { rich_text: [{ text: { content: a.items.join("、").slice(0, 1900) } }] };
  const set = (k: string, v: any) => v !== undefined && (p[k] = v);
  if (a.kind === "meal" || a.kind === "drink") {
    set("meal", sel(meal));
    set("categories", multi(a.categories));
    set("portion", sel(a.portion));
    set("calorie_band", sel(a.calorie_band));
  }
  if (a.kind === "stool" && a.bristol !== null) p.bristol = { number: a.bristol };
  set("flags", multi(a.flags));
  if (fileUploadId) p.photo = { files: [{ type: "file_upload", file_upload: { id: fileUploadId }, name: filename }] };
  return p;
}

function logBody(a: Analysis, note?: string) {
  const lines: string[] = [];
  if (a.notes) lines.push(a.notes);
  if (a.items.length) lines.push(`识别：${a.items.join("、")}`);
  if (note?.trim()) lines.push(`你说：${note.trim()}`);
  if (a.red_flag) lines.push("⚠️ 看到了需要注意的迹象，建议尽快就医。这不是诊断。");
  return lines.map((t) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: t.slice(0, 1900) } }] } }));
}

// ---------- 路由 ----------

app.get("/health", (c) => c.json({ ok: true }));

app.post("/ingest/hae", async (c) => {
  if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
  let payload: any;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "bad json" }, 400);
  }
  const rows = aggregate(payload);
  const results: Record<string, string> = {};
  for (const row of rows) {
    try {
      results[row.date] = await upsertDaily(row);
    } catch (e: any) {
      results[row.date] = `error: ${e?.message ?? e}`;
      console.error(`[ingest] ${row.date}`, e);
    }
  }
  console.log(`[ingest] hae ${JSON.stringify(results)}`);
  return c.json({ ok: true, days: results });
});

// multipart/form-data：photo=<文件>，可选 note=<文字>，可选 taken_at=<ISO 时间>
app.post("/ingest/photo", async (c) => {
  if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.parseBody();
  const file = body["photo"];
  if (!(file instanceof File)) return c.json({ error: "缺少 photo 文件字段" }, 400);
  const note = typeof body["note"] === "string" ? (body["note"] as string) : undefined;
  const takenAt = typeof body["taken_at"] === "string" && !Number.isNaN(Date.parse(body["taken_at"] as string)) ? new Date(body["taken_at"] as string) : new Date();

  const t = localTime(takenAt, TZ);
  const id = randomUUID().slice(0, 8);
  const dir = join(PHOTO_DIR, t.ymd.slice(0, 4), t.ymd.slice(5, 7), t.ymd.slice(8, 10));
  await mkdir(dir, { recursive: true });
  const stem = `${t.iso.slice(11, 19).replace(/:/g, "")}-${id}`;

  // 1) 原图落盘（全部数据都留着，和 Notion 无关）
  const original = Buffer.from(await file.arrayBuffer());
  const ext = (file.name?.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  await writeFile(join(dir, `${stem}.orig.${ext}`), original);

  // 2) 转成模型能吃的 JPEG（长边 ≤1568，按 EXIF 转正）。HEIC 转不了就明说。
  let jpeg: Buffer;
  try {
    jpeg = await sharp(original).rotate().resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  } catch (e: any) {
    console.error("[photo] 转码失败", e?.message ?? e);
    return c.json({ error: "图片格式不支持（HEIC？）。请在快捷指令里加「转换图片 → JPEG」后再上传。" }, 415);
  }
  await writeFile(join(dir, `${stem}.jpg`), jpeg);

  // 3) 看图
  let analysis: Analysis;
  let raw = "";
  try {
    ({ analysis, raw } = await analyzePhoto(jpeg, t.iso, note));
  } catch (e: any) {
    console.error("[photo] 识别失败", e?.message ?? e);
    await appendFile(join(PHOTO_DIR, "log.jsonl"), JSON.stringify({ at: t.iso, file: `${stem}.jpg`, error: String(e?.message ?? e) }) + "\n");
    return c.json({ error: `识别失败：${e?.message ?? e}` }, 502);
  }
  const meal = analysis.kind === "meal" || analysis.kind === "drink" ? mealSlot(t.hour, t.minute) : null;
  if (meal === "夜宵" && !analysis.flags.includes("夜宵")) analysis.flags.push("夜宵");

  // 4) Notion：其他照片不进库（文件已留在盘上），饭和排便进「记录」
  let notionUrl: string | null = null;
  let notionError: string | null = null;
  if (analysis.kind !== "other") {
    try {
      let uploadId: string | null = null;
      try {
        uploadId = await uploadToNotion(jpeg, `${stem}.jpg`);
      } catch (e: any) {
        console.error("[photo] 照片传 Notion 失败，先不带图写记录", e?.message ?? e);
      }
      const page: any = await notion.pages.create({
        parent: { type: "data_source_id", data_source_id: LOG_DS },
        icon: { type: "emoji", emoji: iconFor(analysis.kind) },
        properties: logProps(analysis, t.iso, meal, uploadId, `${stem}.jpg`),
        children: logBody(analysis, note),
      } as any);
      notionUrl = page.url ?? null;
    } catch (e: any) {
      notionError = String(e?.message ?? e);
      console.error("[photo] 写 Notion 失败", notionError);
    }
  }

  // 5) 本机流水（JSONL），永远写
  await appendFile(
    join(PHOTO_DIR, "log.jsonl"),
    JSON.stringify({ at: t.iso, file: `${t.ymd}/${stem}.jpg`, note, meal, ...analysis, notion: notionUrl, notion_error: notionError, raw: raw.slice(0, 2000) }) + "\n",
  );
  console.log(`[photo] ${t.iso} ${analysis.kind} "${analysis.title}" conf=${analysis.confidence} notion=${notionUrl ?? notionError ?? "skip"}`);

  // 带血 / 黑便：不等日报，立刻推一条（配了 Bark 才会推）
  // 6) 给手机的一句话
  const headline =
    analysis.kind === "other"
      ? "没认出是饭还是排便，照片已留档"
      : analysis.kind === "stool"
        ? `排便 · Bristol ${analysis.bristol ?? "?"}${analysis.flags.length ? ` · ${analysis.flags.join("/")}` : ""}`
        : `${meal ?? ""} ${analysis.title}${analysis.calorie_band ? ` · ${analysis.calorie_band}` : ""}`.trim();
  const message = [headline, analysis.notes, notionError ? `（Notion 写入失败：${notionError.slice(0, 80)}）` : ""].filter(Boolean).join("\n");

  // 7) 服务器直接推一条到手机（配了 Bark 才推）。快捷指令自己的"显示通知"在专注模式 / 停用时间下会被吞掉，
  //    这条走 APNs 的时效性通知能穿过去。带血 / 黑便时标题换成警示，不再另发一条。
  void pushPhone(
    analysis.red_flag ? "⚠️ 排便记录有异常标记" : `已记录 · ${analysis.kind === "stool" ? "排便" : analysis.kind === "other" ? "照片" : (meal ?? "饮食")}`,
    analysis.red_flag ? `${headline}\n建议尽快就医，这不是诊断。` : message,
    notionUrl,
    "timeSensitive",
  );

  return c.json({ ok: !notionError, message, kind: analysis.kind, title: analysis.title, meal, analysis, notion_url: notionUrl });
});

// ---------- 市场 + 新闻（公开源，取不到就降级，不影响健康部分） ----------

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
async function getText(url: string, timeoutMs = 12_000): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return await res.text();
}

const HISTORY_FILE = join(PHOTO_DIR, "quotes-history.json"); // 自己攒的收盘历史，算 5 日 / 1 月涨跌用

async function loadHistory(): Promise<History> {
  try {
    return JSON.parse(await readFile(HISTORY_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** 行情：CNBC 一次拿全部标的（这台机器上 Yahoo 限流、Stooq 403）；CNBC 挂了再逐个试 Yahoo。 */
async function fetchQuotes(symbols: string[], history: History): Promise<{ quotes: Quote[]; extended: Record<string, string> }> {
  try {
    const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${symbols.join("|")}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;
    const r = parseCnbcQuotes(JSON.parse(await getText(url)), history);
    if (r.quotes.length) return r;
    throw new Error("CNBC 返回里没有可用行情");
  } catch (e: any) {
    console.error("[brief] cnbc", e?.message ?? e);
  }
  const quotes: Quote[] = [];
  for (const s of symbols) {
    try {
      const q = parseYahooChart(JSON.parse(await getText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1mo&interval=1d`)));
      if (q) quotes.push(q);
    } catch (e: any) {
      console.error(`[brief] yahoo ${s}`, e?.message ?? e);
    }
  }
  return { quotes, extended: {} };
}

async function fetchFeed(url: string, source: string): Promise<NewsItem[]> {
  try {
    return parseRss(await getText(url), source);
  } catch (e: any) {
    console.error(`[brief] rss ${source}`, e?.message ?? e);
    return [];
  }
}

async function buildBrief(ymd: string): Promise<{ brief: Brief; quotes: Quote[] } | null> {
  if (!BRIEF_TICKERS.length) return null;
  const history = await loadHistory();
  const [{ quotes, extended }, tickerNewsList, gn, bbc] = await Promise.all([
    fetchQuotes(BRIEF_TICKERS, history),
    Promise.all(BRIEF_TICKERS.map((s) => fetchFeed(`https://news.google.com/rss/search?q=${encodeURIComponent(`${NEWS_QUERY[s] ?? s} stock when:2d`)}&hl=en-US&gl=US&ceid=US:en`, "Google News"))),
    fetchFeed("https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", "Google News"),
    fetchFeed("https://feeds.bbci.co.uk/news/world/rss.xml", "BBC"),
  ]);
  quotes.sort((a, b) => BRIEF_TICKERS.indexOf(a.symbol) - BRIEF_TICKERS.indexOf(b.symbol));
  const failed = BRIEF_TICKERS.filter((s) => !quotes.some((q) => q.symbol === s));
  const tickerNews: Record<string, NewsItem[]> = {};
  BRIEF_TICKERS.forEach((s, i) => (tickerNews[s] = dedupeNews(tickerNewsList[i], 6)));
  const world = dedupeNews([...gn, ...bbc], 40);

  if (quotes.length) {
    try {
      await mkdir(PHOTO_DIR, { recursive: true });
      await writeFile(HISTORY_FILE, JSON.stringify(updateHistory(history, quotes)));
    } catch (e: any) {
      console.error("[brief] 写历史失败", e?.message ?? e);
    }
  }

  const fb = fallbackMarket(quotes, failed);
  let brief: Brief;
  try {
    const raw = await askModel(BRIEF_SYSTEM_PROMPT.replace("{MAX}", String(Math.round(BRIEF_MAX_CHARS * 0.9))), briefUserPrompt(ymd, quotes, tickerNews, world, failed, extended), 2500);
    brief = parseBrief(raw, world, BRIEF_MAX_CHARS, fb);
    if (!brief.from_model) console.error("[brief] 模型输出不是合法 JSON：", raw.slice(0, 200));
  } catch (e: any) {
    console.error("[brief] 模型失败，用数字兜底", e?.message ?? e);
    brief = { market: fb, news: [], from_model: false };
  }
  console.log(`[brief] ${ymd} quotes=${quotes.length}/${BRIEF_TICKERS.length} world=${world.length} news=${brief.news.length} model=${brief.from_model}`);
  return { brief, quotes };
}

// ---------- 日报 ----------

interface ReportState {
  last_daily?: string; // 最近一次自动日报的日期
  latest?: { date: string; title: string; body: string; summary: string; suggestion: string; notion_url: string | null; generated_at: string };
}

async function loadState(): Promise<ReportState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
async function saveState(s: ReportState) {
  await mkdir(PHOTO_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(s));
}

async function fetchDayEntries(ymd: string) {
  const w = dayWindow(ymd, TZ);
  const pages: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.dataSources.query({
      data_source_id: LOG_DS,
      filter: { and: [{ property: "datetime", date: { on_or_after: w.start } }, { property: "datetime", date: { on_or_before: w.end } }] },
      sorts: [{ property: "datetime", direction: "ascending" }],
      page_size: 100,
      start_cursor: cursor,
    } as any);
    pages.push(...(res.results ?? []));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages.map((p) => fromNotionPage(p, TZ));
}

/** 同一天重跑：把旧的日报页归档，再建新的（替换正文比追加省事也不留垃圾）。 */
async function archiveOldReports(ymd: string) {
  const res: any = await notion.dataSources.query({
    data_source_id: REPORT_DS,
    filter: { and: [{ property: "date", title: { equals: ymd } }, { property: "type", select: { equals: "日报" } }] },
    page_size: 10,
  } as any);
  for (const p of res.results ?? []) await notion.pages.update({ page_id: p.id, archived: true } as any);
}

async function runDailyReport(ymd: string, opts: { push: boolean; cutoff?: string }) {
  if (!REPORT_DS) throw new Error("没配 NOTION_REPORT_DATA_SOURCE_ID");
  const now = localTime(new Date(), TZ);
  const cutoff = opts.cutoff ?? (now.ymd === ymd ? now.iso.slice(11, 16) : "23:59");
  // 健康部分和市场部分并行取；市场部分失败不影响健康部分
  const [entries, market] = await Promise.all([
    fetchDayEntries(ymd),
    buildBrief(ymd).catch((e: any) => {
      console.error("[brief] 整体失败", e?.message ?? e);
      return null;
    }),
  ]);
  const stats: DayStats = summarize(entries, ymd, cutoff);

  let narrative: Narrative;
  if (!entries.length) {
    narrative = { summary: "今天一条饮食 / 排便记录都没有。", observations: ["吃饭、排便记得拍一下，数据全了分析才准。"], suggestion: "明天第一顿就拍。", from_model: false };
  } else {
    try {
      narrative = parseNarrative(await askModel(REPORT_SYSTEM_PROMPT, reportUserPrompt(stats)), stats);
    } catch (e: any) {
      console.error("[report] 模型失败，用规则兜底", e?.message ?? e);
      narrative = parseNarrative("", stats);
    }
  }

  await archiveOldReports(ymd);
  const children = [...reportBlocks(stats, narrative, REPORT_MODEL), ...(market ? briefBlocks(market.brief, market.quotes, BRIEF_TICKERS) : [])];
  const page: any = await notion.pages.create({
    parent: { type: "data_source_id", data_source_id: REPORT_DS },
    icon: { type: "emoji", emoji: stats.red_flag ? "⚠️" : "📋" },
    properties: { ...reportProps(stats, narrative, REPORT_MODEL), ...(market ? briefProps(market.brief) : {}) },
    children: children.slice(0, 100), // Notion 单次创建最多 100 个块
  } as any);
  const notionUrl: string | null = page.url ?? null;

  const text = pushText(stats, narrative);
  const pushed = opts.push ? await pushPhone(text.title, text.body, notionUrl, stats.red_flag ? "timeSensitive" : "active") : false;

  const state = await loadState();
  state.latest = { date: ymd, ...text, summary: narrative.summary, suggestion: narrative.suggestion, notion_url: notionUrl, generated_at: new Date().toISOString() };
  await saveState(state);
  await appendFile(join(PHOTO_DIR, "reports.jsonl"), JSON.stringify({ at: new Date().toISOString(), date: ymd, cutoff, notion: notionUrl, pushed, narrative, anomalies: stats.anomalies, balance: stats.balance_score }) + "\n");
  console.log(`[report] ${ymd} entries=${entries.length} balance=${stats.balance_score} anomalies=${stats.anomalies.length} model=${narrative.from_model} pushed=${pushed} notion=${notionUrl}`);
  return { ok: true, date: ymd, cutoff, entries: entries.length, balance_score: stats.balance_score, anomalies: stats.anomalies, narrative, notion_url: notionUrl, pushed };
}

let reportRunning = false;
async function reportGuarded(ymd: string, opts: { push: boolean; cutoff?: string }) {
  if (reportRunning) throw new Error("上一份日报还在生成");
  reportRunning = true;
  try {
    return await runDailyReport(ymd, opts);
  } finally {
    reportRunning = false;
  }
}

app.post("/ingest/report/run", async (c) => {
  if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
  const q = c.req.query();
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(q.date ?? "") ? (q.date as string) : localTime(new Date(), TZ).ymd;
  const push = q.push !== "0";
  try {
    return c.json(await reportGuarded(ymd, { push }));
  } catch (e: any) {
    console.error("[report] 失败", e?.message ?? e);
    return c.json({ error: String(e?.message ?? e) }, 500);
  }
});

app.get("/ingest/report/latest", async (c) => {
  if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
  const s = await loadState();
  return c.json(s.latest ?? { empty: true, message: "还没有生成过日报" });
});

// 每 30 秒看一眼表：到点了、今天还没跑过 → 跑。容器重启错过了时间也会在当天补跑。
async function tickScheduler() {
  if (!REPORT_DS) return;
  const now = localTime(new Date(), TZ);
  if (now.iso.slice(11, 16) < REPORT_TIME) return;
  const state = await loadState();
  if (state.last_daily === now.ymd) return;
  state.last_daily = now.ymd; // 先记账，失败也不要每 30 秒重试刷模型
  await saveState(state);
  try {
    await reportGuarded(now.ymd, { push: true });
  } catch (e: any) {
    console.error("[report] 定时任务失败", e?.message ?? e);
  }
}
setInterval(() => void tickScheduler().catch((e) => console.error("[report] tick", e)), 30_000);

app.get("/ingest/health", (c) => c.json({ ok: true, model: VISION_MODEL, tz: TZ, report_time: REPORT_TIME, report_db: Boolean(REPORT_DS), push: BARK_KEY ? "bark" : "none" }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`[ingest] listening on ${port} model=${VISION_MODEL} tz=${TZ} report=${REPORT_TIME} push=${BARK_KEY ? "bark" : "none"}`));
