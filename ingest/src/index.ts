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
import { parseCommand, reportMessages, recordReply, esc, HELP_TEXT, PAIR_HINT } from "./telegram.ts";
import { DEFAULT_TARGETS, sumMacros, nutritionLines, parseTargets, targetsLine, type Targets } from "./nutrition.ts";

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
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ""; // 健康记录 bot；空 = 不启用
const TG_STATE_FILE = join(PHOTO_DIR, "telegram-state.json");
const GATEWAY_URL = (process.env.OPENCLAW_URL || "http://openclaw:18789").replace(/\/$/, ""); // 同一个 compose 网络里的网关
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || ""; // 和 .env 里网关的 token 一样；空 = 不转发给 agent

const notion = new Client({ auth: NOTION_TOKEN, notionVersion: "2025-09-03" });
const app = new Hono();

const authed = (c: any) => (c.req.header("authorization") ?? "") === `Bearer ${INGEST_TOKEN}`;

// ---------- 文本模型（日报点评） ----------

export class ModelError extends Error {
  status: number;
  kind: "credit" | "auth" | "rate" | "server" | "other";
  constructor(status: number, body: string) {
    super(`模型调用失败 ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.kind = /credit balance/i.test(body) ? "credit" : status === 401 || status === 403 ? "auth" : status === 429 ? "rate" : status >= 500 ? "server" : "other";
  }
  /** 给人看的一句话 */
  human(): string {
    return this.kind === "credit"
      ? "Anthropic API 额度用完了（console.anthropic.com → Plans & Billing 充值）"
      : this.kind === "auth"
        ? "Anthropic API key 无效或被撤销"
        : this.kind === "rate"
          ? "Anthropic API 限流"
          : this.kind === "server"
            ? "Anthropic API 服务端错误"
            : `Anthropic API 返回 ${this.status}`;
  }
}

/** 文本模型调用：限流 / 5xx 重试两次；额度用完或 key 错不重试，直接抛 ModelError 让上层写进报告。 */
async function askModel(system: string, user: string, maxTokens = 600, model = REPORT_MODEL): Promise<string> {
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 3000 * attempt));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    if (res.ok) {
      const data: any = await res.json();
      return (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    }
    lastErr = new ModelError(res.status, await res.text());
    if (lastErr.kind !== "rate" && lastErr.kind !== "server") break;
  }
  throw lastErr;
}
const modelErrorText = (e: any) => (e instanceof ModelError ? e.human() : String(e?.message ?? e).slice(0, 120));

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
  if (!res.ok) throw new ModelError(res.status, await res.text());
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

function logProps(a: Analysis, iso: string, meal: string | null, fileUploadId: string | null, filename: string, source = "手机拍照", model = VISION_MODEL) {
  const sel = (name: string | null) => (name ? { select: { name } } : undefined);
  const multi = (names: string[]) => (names.length ? { multi_select: names.map((name) => ({ name })) } : undefined);
  const p: Record<string, any> = {
    text: { title: [{ text: { content: a.title } }] },
    datetime: { date: { start: iso } },
    type: { select: { name: notionType(a.kind, a.categories) } },
    source: { select: { name: source } },
    confidence: { number: Math.round(a.confidence * 100) / 100 },
    agent_note: { rich_text: [{ text: { content: `${a.notes} [${model}]`.slice(0, 1900) } }] },
  };
  if (a.items.length) p.items = { rich_text: [{ text: { content: a.items.join("、").slice(0, 1900) } }] };
  if (a.kcal !== null) p.kcal = { number: a.kcal };
  if (a.protein_g !== null) p.protein_g = { number: a.protein_g };
  if (a.fat_g !== null) p.fat_g = { number: a.fat_g };
  if (a.carb_g !== null) p.carb_g = { number: a.carb_g };
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
/** 今天累计（Notion 记录库里有数字的饮食记录），可排除刚写入的那一页（避免读到旧快照后再加一次）。 */
async function todayTotals(excludePageId: string | null, extra: Analysis | null) {
  const ymd = localTime(new Date(), TZ).ymd;
  const entries = (await fetchDayEntries(ymd)).filter((e) => e.id !== excludePageId && (e.type === "饮食" || e.type === "咖啡因" || e.type === "酒精"));
  const rows = entries.map((e) => ({ kcal: e.kcal, protein_g: e.protein_g, fat_g: e.fat_g, carb_g: e.carb_g }));
  if (extra && (extra.kind === "meal" || extra.kind === "drink")) rows.push({ kcal: extra.kcal, protein_g: extra.protein_g, fat_g: extra.fat_g, carb_g: extra.carb_g });
  return sumMacros(rows);
}
async function currentTargets(): Promise<Targets> {
  return (await loadState()).targets ?? DEFAULT_TARGETS;
}
/** 记录完一顿后附在回复后面的三行：这顿多少、今天累计、还差多少。拿不到就空数组，不影响记录。 */
async function intakeLines(a: Analysis, pageId: string | null): Promise<string[]> {
  if (a.kind !== "meal" && a.kind !== "drink") return [];
  try {
    const [totals, targets] = await Promise.all([todayTotals(pageId, a), currentTargets()]);
    return nutritionLines(a, totals, targets);
  } catch (e: any) {
    console.error("[intake] 累计失败", e?.message ?? e);
    return a.kcal !== null ? [`这顿约 ${a.kcal} 千卡（蛋白 ${a.protein_g ?? "?"}g · 脂肪 ${a.fat_g ?? "?"}g · 碳水 ${a.carb_g ?? "?"}g）`] : [];
  }
}

interface PhotoResult {
  ok: boolean;
  status: number; // 给 HTTP 用
  message: string; // 给人看的几行字
  kind?: Analysis["kind"];
  title?: string;
  meal?: string | null;
  analysis?: Analysis;
  notion_url?: string | null;
  red_flag?: boolean;
}

/** 一张照片的完整流程：落盘 → 转 JPEG → 看图 → 写 Notion → 流水。HTTP 入口和 Telegram 入口共用。 */
async function processPhoto(original: Buffer, opts: { ext?: string; note?: string; takenAt?: Date; source?: string }): Promise<PhotoResult> {
  const takenAt = opts.takenAt ?? new Date();
  const note = opts.note;
  const source = opts.source ?? "手机拍照";
  const t = localTime(takenAt, TZ);
  const id = randomUUID().slice(0, 8);
  const dir = join(PHOTO_DIR, t.ymd.slice(0, 4), t.ymd.slice(5, 7), t.ymd.slice(8, 10));
  await mkdir(dir, { recursive: true });
  const stem = `${t.iso.slice(11, 19).replace(/:/g, "")}-${id}`;

  // 1) 原图落盘（全部数据都留着，和 Notion 无关）
  const ext = (opts.ext || "bin").toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  await writeFile(join(dir, `${stem}.orig.${ext}`), original);

  // 2) 转成模型能吃的 JPEG（长边 ≤1568，按 EXIF 转正）。HEIC 转不了就明说。
  let jpeg: Buffer;
  try {
    jpeg = await sharp(original).rotate().resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  } catch (e: any) {
    console.error("[photo] 转码失败", e?.message ?? e);
    return { ok: false, status: 415, message: "图片格式不支持（HEIC？）。请在快捷指令里加「转换图片 → JPEG」后再上传。" };
  }
  await writeFile(join(dir, `${stem}.jpg`), jpeg);

  // 3) 看图
  let analysis: Analysis;
  let raw = "";
  try {
    ({ analysis, raw } = await analyzePhoto(jpeg, t.iso, note));
  } catch (e: any) {
    console.error("[photo] 识别失败", e?.message ?? e);
    await appendFile(join(PHOTO_DIR, "log.jsonl"), JSON.stringify({ at: t.iso, file: `${stem}.jpg`, source, error: String(e?.message ?? e) }) + "\n");
    return { ok: false, status: 502, message: `识别失败：${modelErrorText(e)}。照片已留档，不会丢。` };
  }
  const meal = analysis.kind === "meal" || analysis.kind === "drink" ? mealSlot(t.hour, t.minute) : null;
  if (meal === "夜宵" && !analysis.flags.includes("夜宵")) analysis.flags.push("夜宵");

  // 4) Notion：其他照片不进库（文件已留在盘上），饭和排便进「记录」
  let notionUrl: string | null = null;
  let notionError: string | null = null;
  let pageId: string | null = null;
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
        properties: logProps(analysis, t.iso, meal, uploadId, `${stem}.jpg`, source),
        children: logBody(analysis, note),
      } as any);
      notionUrl = page.url ?? null;
      pageId = page.id ?? null;
    } catch (e: any) {
      notionError = String(e?.message ?? e);
      console.error("[photo] 写 Notion 失败", notionError);
    }
  }

  // 5) 本机流水（JSONL），永远写
  await appendFile(
    join(PHOTO_DIR, "log.jsonl"),
    JSON.stringify({ at: t.iso, file: `${t.ymd}/${stem}.jpg`, source, note, meal, ...analysis, notion: notionUrl, notion_error: notionError, raw: raw.slice(0, 2000) }) + "\n",
  );
  console.log(`[photo] ${t.iso} ${source} ${analysis.kind} "${analysis.title}" conf=${analysis.confidence} notion=${notionUrl ?? notionError ?? "skip"}`);

  // 6) 给人看的几行字
  const headline =
    analysis.kind === "other"
      ? "没认出是饭还是排便，照片已留档"
      : analysis.kind === "stool"
        ? `排便 · Bristol ${analysis.bristol ?? "?"}${analysis.flags.length ? ` · ${analysis.flags.join("/")}` : ""}`
        : `${meal ?? ""} ${analysis.title}${analysis.calorie_band ? ` · ${analysis.calorie_band}` : ""}`.trim();
  const intake = await intakeLines(analysis, pageId);
  const message = [headline, analysis.notes, ...intake, analysis.red_flag ? "⚠️ 建议尽快就医，这不是诊断。" : "", notionError ? `（Notion 写入失败：${notionError.slice(0, 80)}）` : ""].filter(Boolean).join("\n");

  // 7) Bark（可选）。Telegram 入口自己回消息，不走这里。
  if (source !== "Telegram") {
    void pushPhone(
      analysis.red_flag ? "⚠️ 排便记录有异常标记" : `已记录 · ${analysis.kind === "stool" ? "排便" : analysis.kind === "other" ? "照片" : (meal ?? "饮食")}`,
      message,
      notionUrl,
      "timeSensitive",
    );
  } else if (analysis.red_flag) {
    void pushPhone("⚠️ 排便记录有异常标记", message, notionUrl, "timeSensitive");
  }

  return { ok: !notionError, status: notionError ? 207 : 200, message, kind: analysis.kind, title: analysis.title, meal, analysis, notion_url: notionUrl, red_flag: analysis.red_flag };
}

app.post("/ingest/photo", async (c) => {
  if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.parseBody();
  const file = body["photo"];
  if (!(file instanceof File)) return c.json({ error: "缺少 photo 文件字段" }, 400);
  const note = typeof body["note"] === "string" ? (body["note"] as string) : undefined;
  const takenAt = typeof body["taken_at"] === "string" && !Number.isNaN(Date.parse(body["taken_at"] as string)) ? new Date(body["taken_at"] as string) : new Date();
  const r = await processPhoto(Buffer.from(await file.arrayBuffer()), { ext: file.name?.split(".").pop(), note, takenAt, source: "手机拍照" });
  if (!r.ok && r.status >= 400) return c.json({ error: r.message }, r.status as any);
  void tgBroadcast([`📷 ${recordReply(r)}`]);
  return c.json({ ok: r.ok, message: r.message, kind: r.kind, title: r.title, meal: r.meal, analysis: r.analysis, notion_url: r.notion_url });
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

async function buildBrief(ymd: string): Promise<{ brief: Brief; quotes: Quote[]; model_error?: string } | null> {
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
  let model_error: string | undefined;
  try {
    const raw = await askModel(BRIEF_SYSTEM_PROMPT.replace("{MAX}", String(Math.round(BRIEF_MAX_CHARS * 0.9))), briefUserPrompt(ymd, quotes, tickerNews, world, failed, extended), 2500);
    brief = parseBrief(raw, world, BRIEF_MAX_CHARS, fb);
    if (!brief.from_model) console.error("[brief] 模型输出不是合法 JSON：", raw.slice(0, 200));
  } catch (e: any) {
    model_error = modelErrorText(e);
    console.error("[brief] 模型失败，用数字兜底", e?.message ?? e);
    brief = { market: `${fb}（模型没跑成：${model_error}，今天只有数字）`, news: [], from_model: false };
  }
  console.log(`[brief] ${ymd} quotes=${quotes.length}/${BRIEF_TICKERS.length} world=${world.length} news=${brief.news.length} model=${brief.from_model}`);
  return { brief, quotes, model_error };
}

/** 美股收盘后记一次收盘价进历史（每个交易日一次），日报的 5 日 / 1 月涨跌和盘前时段的日涨跌都靠它。 */
async function snapshotCloses(): Promise<void> {
  if (!BRIEF_TICKERS.length) return;
  const history = await loadHistory();
  const { quotes } = await fetchQuotes(BRIEF_TICKERS, history);
  if (!quotes.length) throw new Error("没拿到行情");
  await mkdir(PHOTO_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(updateHistory(history, quotes)));
  console.log(`[brief] 收盘快照 ${quotes.map((q) => `${q.symbol}@${q.session_date}=${q.last}`).join(" ")}`);
}

function nyNow(): { date: string; hm: string } {
  const d = new Date();
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const g = (t: string) => f.formatToParts(d).find((p) => p.type === t)?.value ?? "00";
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hm: `${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}` };
}

// ---------- 日报 ----------

interface ReportState {
  targets?: Targets; // 每日热量 / 三大营养素目标（/target 改）
  last_daily?: string; // 最近一次自动日报的日期
  last_close_snapshot?: string; // 最近一次收盘快照对应的纽约日期
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
  const stats: DayStats = summarize(entries, ymd, cutoff, await currentTargets());

  let narrative: Narrative;
  if (!entries.length) {
    narrative = { summary: "今天一条饮食 / 排便记录都没有。", observations: ["吃饭、排便记得拍一下，数据全了分析才准。"], suggestion: "明天第一顿就拍。", from_model: false };
  } else {
    try {
      narrative = parseNarrative(await askModel(REPORT_SYSTEM_PROMPT, reportUserPrompt(stats)), stats);
    } catch (e: any) {
      console.error("[report] 模型失败，用规则兜底", e?.message ?? e);
      narrative = parseNarrative("", stats);
      narrative.observations = [`模型没跑成（${modelErrorText(e)}），下面是规则生成的。`, ...narrative.observations].slice(0, 4);
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
  let pushed = false;
  if (opts.push) {
    const tg = await tgBroadcast(reportMessages(stats, narrative, market?.brief ?? null, market?.quotes ?? [], notionUrl));
    const bark = await pushPhone(text.title, text.body, notionUrl, stats.red_flag ? "timeSensitive" : "active");
    pushed = tg || bark;
  }

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

// 文字记录（没照片）：快捷指令 / 测试用。body: {"text": "一杯豆浆"} 或表单字段 text
app.post("/ingest/text", async (c) => {
  if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
  let text = "";
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("application/json")) text = String((await c.req.json().catch(() => ({})))?.text ?? "");
  else text = String((await c.req.parseBody().catch(() => ({})))["text"] ?? "");
  text = text.trim();
  if (!text) return c.json({ error: "缺少 text" }, 400);
  const r = await processText(text, "快捷指令");
  if (r.kind === "other") return c.json({ ok: true, logged: false, message: "没看出是在记吃喝 / 排便，没记。" });
  void tgBroadcast([`✍️ ${recordReply(r)}`]);
  return c.json({ ok: r.ok, logged: r.ok, message: r.message, kind: r.kind, title: r.title, meal: r.meal, analysis: r.analysis, notion_url: r.notion_url });
});

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
  const state = await loadState();
  // 1) 美股收盘后（16:35 纽约时间起）记一次收盘价；周末 CNBC 还是周五的日期，updateHistory 会去重
  const ny = nyNow();
  if (BRIEF_TICKERS.length && ny.hm >= "16:35" && state.last_close_snapshot !== ny.date) {
    state.last_close_snapshot = ny.date;
    await saveState(state);
    try {
      await snapshotCloses();
    } catch (e: any) {
      console.error("[brief] 收盘快照失败", e?.message ?? e);
    }
  }
  // 2) 日报
  if (!REPORT_DS) return;
  const now = localTime(new Date(), TZ);
  if (now.iso.slice(11, 16) < REPORT_TIME) return;
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


// ---------- Telegram 健康记录 bot（长轮询，不需要公网回调；配了 TELEGRAM_BOT_TOKEN 才启动） ----------

interface TgState {
  chats: number[]; // 配对过的对话
  offset: number; // getUpdates 游标
}
let tgState: TgState = { chats: [], offset: 0 };
async function tgLoad() {
  try {
    tgState = { chats: [], offset: 0, ...JSON.parse(await readFile(TG_STATE_FILE, "utf8")) };
  } catch {}
}
async function tgSave() {
  await mkdir(PHOTO_DIR, { recursive: true });
  await writeFile(TG_STATE_FILE, JSON.stringify(tgState));
}
async function tgApi(method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`telegram ${method} ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data.result;
}
async function tgSend(chatId: number, html: string) {
  try {
    await tgApi("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true });
  } catch (e: any) {
    console.error("[tg] 发送失败", e?.message ?? e);
    // HTML 解析失败就退回纯文本
    if (/can't parse entities/i.test(String(e?.message))) await tgApi("sendMessage", { chat_id: chatId, text: html.replace(/<[^>]+>/g, "") }).catch(() => {});
  }
}
/** 纯文本发送（agent 的回答带 markdown，走 HTML 解析容易炸），超长自动切段。 */
async function tgSendPlain(chatId: number, text: string) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
  for (const c of chunks.length ? chunks : ["（空）"]) {
    try {
      await tgApi("sendMessage", { chat_id: chatId, text: c, disable_web_page_preview: true });
    } catch (e: any) {
      console.error("[tg] 发送失败", e?.message ?? e);
    }
  }
}
/** agent 跑起来可能要几十秒，期间每 4 秒续一次"正在输入"。 */
function typingKeepalive(chatId: number): () => void {
  const tick = () => void tgApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  tick();
  const h = setInterval(tick, 4000);
  return () => clearInterval(h);
}

/** 发给所有配对的对话；返回是否至少发出去一条。 */
async function tgBroadcast(messages: string[]): Promise<boolean> {
  if (!TELEGRAM_BOT_TOKEN || !tgState.chats.length) return false;
  for (const chat of tgState.chats) for (const m of messages) await tgSend(chat, m);
  return true;
}

/** 文字记录（没照片）：同一套提示词，告诉模型这是文字描述。用 Haiku 当"分拣员"：是记录就结构化，不是记录（提问 / 聊天 / 命令）就 other，交给 agent。 */
async function analyzeText(text: string, iso: string): Promise<{ analysis: Analysis; model: string }> {
  const prompt = `${userPrompt(iso)}\n这次没有照片，用户发来一句话：「${text}」。\n只有当这句话是在**记录自己刚吃喝了什么或排便情况**时，才按同样的 JSON 格式输出（份量说不清就填 中）。如果它是提问、闲聊、命令、感想、或别的任何事，kind 一律填 "other"，不要猜。无论哪种情况都只输出 JSON。`;
  let model = "claude-haiku-5-5";
  let raw = await askModel(SYSTEM_PROMPT, prompt, 700, model);
  let a: Analysis;
  try {
    a = parseAnalysis(raw);
  } catch {
    // Haiku 偶尔不给 JSON（比如反问一句），换 Sonnet 再来一次
    model = VISION_MODEL;
    raw = await askModel(SYSTEM_PROMPT, prompt, 700, model);
    a = parseAnalysis(raw);
  }
  if (a.kind !== "stool" && a.kind !== "other" && !a.items.length) a.kind = "other"; // 没有具体食物就不算记录
  return { analysis: a, model };
}

/** 把一句话交给 OpenClaw 的 agent（有 Notion、记忆、技能），同一个 Telegram 对话 = 同一个会话。 */
async function askAgent(chatId: number, text: string): Promise<string> {
  if (!GATEWAY_TOKEN) throw new Error("没配 OPENCLAW_GATEWAY_TOKEN，转不了 agent");
  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${GATEWAY_TOKEN}`, "x-openclaw-agent-id": "main", "x-openclaw-message-channel": "telegram" },
    body: JSON.stringify({ model: "openclaw", user: `telegram:${chatId}`, messages: [{ role: "user", content: text }] }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`agent ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  const textOut = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => c?.text ?? "").join("") : "";
  return textOut.trim() || "（agent 没有返回内容）";
}
async function processText(text: string, source: string): Promise<PhotoResult> {
  const t = localTime(new Date(), TZ);
  let analysis: Analysis;
  let model = VISION_MODEL;
  try {
    ({ analysis, model } = await analyzeText(text, t.iso));
  } catch (e: any) {
    return { ok: false, status: 502, message: `没记上：${modelErrorText(e)}` };
  }
  if (analysis.kind === "other") return { ok: true, status: 200, message: "", kind: "other" };
  const meal = analysis.kind === "meal" || analysis.kind === "drink" ? mealSlot(t.hour, t.minute) : null;
  if (meal === "夜宵" && !analysis.flags.includes("夜宵")) analysis.flags.push("夜宵");
  let notionUrl: string | null = null;
  let notionError: string | null = null;
  let pageId: string | null = null;
  try {
    const props = logProps(analysis, t.iso, meal, null, "", source, model);
    const page: any = await notion.pages.create({ parent: { type: "data_source_id", data_source_id: LOG_DS }, icon: { type: "emoji", emoji: iconFor(analysis.kind) }, properties: props, children: logBody(analysis, text) } as any);
    notionUrl = page.url ?? null;
    pageId = page.id ?? null;
  } catch (e: any) {
    notionError = String(e?.message ?? e);
  }
  await appendFile(join(PHOTO_DIR, "log.jsonl"), JSON.stringify({ at: t.iso, source, text, meal, ...analysis, notion: notionUrl, notion_error: notionError }) + "\n");
  const headline = analysis.kind === "stool" ? `排便 · Bristol ${analysis.bristol ?? "?"}` : `${meal ?? ""} ${analysis.title}${analysis.calorie_band ? ` · ${analysis.calorie_band}` : ""}`.trim();
  const intake = await intakeLines(analysis, pageId);
  const message = [headline, analysis.notes, ...intake, notionError ? `（Notion 写入失败：${notionError.slice(0, 80)}）` : ""].filter(Boolean).join("\n");
  console.log(`[text] ${t.iso} ${source} ${analysis.kind} "${analysis.title}" notion=${notionUrl ?? notionError}`);
  return { ok: !notionError, status: 200, message, kind: analysis.kind, title: analysis.title, meal, analysis, notion_url: notionUrl, red_flag: analysis.red_flag };
}

async function tgDownload(fileId: string): Promise<{ buf: Buffer; ext: string }> {
  const f: any = await tgApi("getFile", { file_id: fileId });
  const path: string = f.file_path;
  const res = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${path}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`下载失败 ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), ext: path.split(".").pop() || "jpg" };
}

async function tgHandle(msg: any) {
  const chatId: number = msg.chat?.id;
  if (!chatId) return;
  const paired = tgState.chats.includes(chatId);
  const cmd = parseCommand(msg.text);

  if (cmd?.name === "pair") {
    if (cmd.arg && cmd.arg === INGEST_TOKEN) {
      if (!paired) {
        tgState.chats.push(chatId);
        await tgSave();
      }
      await tgSend(chatId, "配对成功 ✅ 直接发照片或文字就能记。发 /help 看用法。");
    } else await tgSend(chatId, "token 不对。格式：<code>/pair 你的INGEST_TOKEN</code>");
    return;
  }
  if (!paired) {
    await tgSend(chatId, PAIR_HINT);
    return;
  }
  if (cmd?.name === "unpair") {
    tgState.chats = tgState.chats.filter((c) => c !== chatId);
    await tgSave();
    await tgSend(chatId, "已取消配对。");
    return;
  }
  if (cmd?.name === "start" || cmd?.name === "help") {
    await tgSend(chatId, HELP_TEXT);
    return;
  }
  if (cmd?.name === "target") {
    const parsed = parseTargets(cmd.arg);
    if (parsed === "bad") {
      await tgSend(chatId, "格式：<code>/target 热量 蛋白 脂肪 碳水</code>，比如 <code>/target 2000 120 65 250</code>");
      return;
    }
    if (parsed) {
      const st = await loadState();
      st.targets = parsed;
      await saveState(st);
      await tgSend(chatId, `已更新。${esc(targetsLine(parsed))}`);
      return;
    }
    await tgSend(chatId, esc(targetsLine(await currentTargets())));
    return;
  }
  if (cmd?.name === "today") {
    try {
      const [totals, targets] = await Promise.all([todayTotals(null, null), currentTargets()]);
      await tgSend(chatId, esc(nutritionLines(null, totals, targets).join("\n")));
    } catch (e: any) {
      await tgSend(chatId, `查不到：${esc(String(e?.message ?? e).slice(0, 160))}`);
    }
    return;
  }
  if (cmd?.name === "report") {
    await tgSend(chatId, "生成中，大概半分钟…");
    try {
      const ymd = /^\d{4}-\d{2}-\d{2}$/.test(cmd.arg) ? cmd.arg : localTime(new Date(), TZ).ymd;
      await reportGuarded(ymd, { push: true });
    } catch (e: any) {
      await tgSend(chatId, `日报失败：${esc(String(e?.message ?? e).slice(0, 200))}`);
    }
    return;
  }

  const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
  const doc = msg.document && /^image\//.test(msg.document.mime_type ?? "") ? msg.document : null;
  if (photo || doc) {
    void tgApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    try {
      const { buf, ext } = await tgDownload((photo ?? doc).file_id);
      const takenAt = typeof msg.date === "number" ? new Date(msg.date * 1000) : new Date();
      const r = await processPhoto(buf, { ext, note: msg.caption, takenAt, source: "Telegram" });
      await tgSend(chatId, recordReply(r));
    } catch (e: any) {
      await tgSend(chatId, `没处理成：${esc(String(e?.message ?? e).slice(0, 200))}`);
    }
    return;
  }
  if (typeof msg.text === "string" && msg.text.trim()) {
    const text = msg.text.trim();
    const stop = typingKeepalive(chatId);
    try {
      const r = await processText(text, "Telegram");
      if (r.kind !== "other") {
        await tgSend(chatId, recordReply(r));
        return;
      }
      if (!r.ok) {
        await tgSend(chatId, recordReply(r)); // 模型挂了之类，直接说
        return;
      }
      // 不是记录 → 交给 agent 聊 / 干活
      try {
        const t0 = Date.now();
        const answer = await askAgent(chatId, text);
        console.log(`[tg] agent ${chatId} ${Math.round((Date.now() - t0) / 1000)}s "${text.slice(0, 40)}" -> ${answer.length} chars`);
        await tgSendPlain(chatId, answer);
      } catch (e: any) {
        console.error("[tg] agent 失败", e?.message ?? e);
        await tgSend(chatId, `agent 没回：${esc(String(e?.message ?? e).slice(0, 160))}`);
      }
    } finally {
      stop();
    }
    return;
  }
  await tgSend(chatId, "发照片、文字，或者直接问我问题。");
}

async function tgPollLoop() {
  await tgLoad();
  console.log(`[tg] bot 启动，已配对对话 ${tgState.chats.length} 个`);
  for (;;) {
    try {
      const updates: any[] = await tgApi("getUpdates", { offset: tgState.offset, timeout: 50, allowed_updates: ["message"] }, 65_000);
      for (const u of updates) {
        tgState.offset = Math.max(tgState.offset, u.update_id + 1);
        try {
          if (u.message) await tgHandle(u.message);
        } catch (e: any) {
          console.error("[tg] 处理消息失败", e?.message ?? e);
        }
      }
      if (updates.length) await tgSave();
    } catch (e: any) {
      console.error("[tg] 轮询失败", e?.message ?? e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
if (TELEGRAM_BOT_TOKEN) void tgPollLoop();

app.get("/ingest/health", (c) => c.json({ ok: true, model: VISION_MODEL, tz: TZ, report_time: REPORT_TIME, report_db: Boolean(REPORT_DS), push: BARK_KEY ? "bark" : "none", telegram: TELEGRAM_BOT_TOKEN ? { enabled: true, paired_chats: tgState.chats.length } : { enabled: false } }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`[ingest] listening on ${port} model=${VISION_MODEL} tz=${TZ} report=${REPORT_TIME} push=${BARK_KEY ? "bark" : "none"} telegram=${TELEGRAM_BOT_TOKEN ? "on" : "off"}`));
