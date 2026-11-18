// 健康数据接收端（Hono + 官方 Notion SDK v5）。两个入口：
//   POST /ingest/hae    Health Auto Export 每小时推 Apple Health 数据 → Notion「每日指标」upsert（纯搬运，不调模型）
//   POST /ingest/photo  手机一键拍照 → 视觉模型识别（饭 / 饮品 / 排便） → 原图存盘 + Notion「记录」一行（附照片）
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Client } from "@notionhq/client";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

import { aggregate, type Daily } from "./hae.ts";
import { SYSTEM_PROMPT, userPrompt, parseAnalysis, mealSlot, localTime, notionType, type Analysis } from "./photo.ts";

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
const PHOTO_DIR = process.env.PHOTO_DIR || "/data/photos";
const TZ = process.env.TZ || "Asia/Shanghai";

const notion = new Client({ auth: NOTION_TOKEN, notionVersion: "2025-09-03" });
const app = new Hono();

const authed = (c: any) => (c.req.header("authorization") ?? "") === `Bearer ${INGEST_TOKEN}`;

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
    type: { select: { name: notionType(a.kind) } },
    source: { select: { name: "手机拍照" } },
    confidence: { number: Math.round(a.confidence * 100) / 100 },
    agent_note: { rich_text: [{ text: { content: JSON.stringify({ kind: a.kind, items: a.items, model: VISION_MODEL }).slice(0, 1900) } }] },
  };
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

function logBody(a: Analysis) {
  const lines: string[] = [];
  if (a.notes) lines.push(a.notes);
  if (a.items.length) lines.push(`识别：${a.items.join("、")}`);
  if (a.red_flag) lines.push("⚠️ 看到了需要注意的迹象，建议尽快就医。这不是诊断。");
  return lines.map((t) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: t.slice(0, 1900) } }] } }));
}

// ---------- 路由 ----------

app.get("/health", (c) => c.json({ ok: true }));
app.get("/ingest/health", (c) => c.json({ ok: true, model: VISION_MODEL, tz: TZ }));

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
        properties: logProps(analysis, t.iso, meal, uploadId, `${stem}.jpg`),
        children: logBody(analysis),
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

  // 6) 给手机的一句话（快捷指令弹通知用）
  const headline =
    analysis.kind === "other"
      ? "没认出是饭还是排便，照片已留档"
      : analysis.kind === "stool"
        ? `排便 · Bristol ${analysis.bristol ?? "?"}${analysis.flags.length ? ` · ${analysis.flags.join("/")}` : ""}`
        : `${meal ?? ""} ${analysis.title}${analysis.calorie_band ? ` · ${analysis.calorie_band}` : ""}`.trim();
  const message = [headline, analysis.notes, notionError ? `（Notion 写入失败：${notionError.slice(0, 80)}）` : ""].filter(Boolean).join("\n");
  return c.json({ ok: !notionError, message, kind: analysis.kind, title: analysis.title, meal, analysis, notion_url: notionUrl });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`[ingest] listening on ${port} model=${VISION_MODEL} tz=${TZ}`));
