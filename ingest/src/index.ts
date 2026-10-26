// 健康数据接收端：Health Auto Export 每小时 POST 过来，按 date 往 Notion「每日指标」upsert。
// 只搬数据，不调模型。几十行，Hono + 官方 Notion SDK v5。
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Client } from "@notionhq/client";

const env = (k: string, required = true): string => {
  const v = process.env[k];
  if (!v && required) throw new Error(`缺少环境变量 ${k}`);
  return v ?? "";
};

const NOTION_TOKEN = env("NOTION_TOKEN");
const DAILY_DS = env("NOTION_DAILY_DATA_SOURCE_ID"); // 每日指标库的 data source id
const INGEST_TOKEN = env("INGEST_TOKEN"); // Health Auto Export 请求头里带的密码

const notion = new Client({ auth: NOTION_TOKEN, notionVersion: "2025-09-03" });
const app = new Hono();

import { aggregate, type Daily } from "./hae.ts";

// ---------- Notion upsert ----------

function props(row: Daily) {
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

async function upsert(row: Daily): Promise<"created" | "updated"> {
  const found = await notion.dataSources.query({
    data_source_id: DAILY_DS,
    filter: { property: "date", title: { equals: row.date } },
    page_size: 1,
  } as any);
  const existing = (found as any).results?.[0];
  if (existing) {
    await notion.pages.update({ page_id: existing.id, properties: props(row) } as any);
    return "updated";
  }
  await notion.pages.create({ parent: { type: "data_source_id", data_source_id: DAILY_DS }, properties: props(row) } as any);
  return "created";
}

// ---------- 路由 ----------

app.get("/health", (c) => c.json({ ok: true }));

app.post("/ingest/hae", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${INGEST_TOKEN}`) return c.json({ error: "unauthorized" }, 401);

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
      results[row.date] = await upsert(row);
    } catch (e: any) {
      results[row.date] = `error: ${e?.message ?? e}`;
      console.error(`[ingest] ${row.date}`, e);
    }
  }
  console.log(`[ingest] ${JSON.stringify(results)}`);
  return c.json({ ok: true, days: results });
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`[ingest] listening on ${port}`));
