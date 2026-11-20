// 日报的纯逻辑：把「记录 Log」一天的行统计成数字、按规则列异常、拼给模型的提示词、校验模型输出、生成 Notion 页面。
// 所有数字都在这里算，模型只负责"说人话"。不碰网络，方便用 node:test 测。
import { MEALS, type Meal, localTime } from "./photo.ts";
import { sumMacros, type Totals, type Targets } from "./nutrition.ts";

/** 五大基础类别：覆盖几类 × 20 = 均衡度（0–100）。规则简单透明，不是营养学评分。 */
export const BASIC_GROUPS = ["主食", "蛋白", "蔬菜", "水果", "乳制品"] as const;
/** 要数次数的"留意"类别 */
export const WATCH_GROUPS = ["糖饮", "酒精", "咖啡因", "油炸", "外卖", "零食"] as const;
const MAIN_MEALS: Meal[] = ["早餐", "午餐", "晚餐"];

export interface LogEntry {
  id: string;
  url: string | null;
  iso: string; // 记录库里的 datetime.start
  hm: string; // 本地 "HH:MM"
  type: string; // 饮食 / 排便 / 咖啡因 / 酒精 / 心情 / 症状 / 备注 / 其他
  title: string;
  items: string[];
  meal: Meal | null;
  categories: string[];
  portion: string | null;
  calorie_band: string | null;
  kcal: number | null;
  protein_g: number | null;
  fat_g: number | null;
  carb_g: number | null;
  bristol: number | null;
  flags: string[];
  confidence: number | null;
}

export interface DayStats {
  date: string; // YYYY-MM-DD
  cutoff: string; // 统计截至的本地时间 "HH:MM"
  entries: LogEntry[];
  diet: LogEntry[]; // 饮食 + 咖啡因 + 酒精
  stools: LogEntry[];
  others: LogEntry[]; // 心情 / 症状 / 备注 / 其他
  meals_eaten: Meal[]; // 早/午/晚 去重，按顺序
  meals_missing: Meal[]; // 到 cutoff 为止本该吃了却没记录的正餐
  snacks: number; // 加餐次数
  late_night: number; // 夜宵次数
  big_portions: number;
  calorie: Record<string, number>; // 轻/中/重 各几次
  categories: Record<string, number>; // 每个类别出现在几条记录里
  covered: string[]; // 五大类里覆盖到的
  missing_groups: string[]; // 五大类里没碰的
  balance_score: number | null; // 没饮食记录时为 null
  totals: Totals; // 当天热量 / 三大营养素累计（只算有数字的记录）
  targets: Targets | null;
  bristol: number[];
  flags: string[]; // 当天所有记录的 flags 并集
  red_flag: boolean; // 带血 / 黑便
  anomalies: string[];
}

export interface Narrative {
  summary: string;
  observations: string[];
  suggestion: string;
  from_model: boolean;
}

// ---------- Notion → LogEntry ----------

const plain = (rt: any[] | undefined) => (rt ?? []).map((t) => t?.plain_text ?? t?.text?.content ?? "").join("");

/** 把 Notion API 返回的一页（记录库）压成我们自己的结构。字段缺了就给空值，不抛错。 */
export function fromNotionPage(page: any, tz: string): LogEntry {
  const p = page?.properties ?? {};
  const start: string = p.datetime?.date?.start ?? page?.created_time ?? new Date(0).toISOString();
  const local = localTime(new Date(start), tz);
  const items = plain(p.items?.rich_text)
    .split(/[、,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const meal = p.meal?.select?.name ?? null;
  return {
    id: page?.id ?? "",
    url: page?.url ?? null,
    iso: start,
    hm: local.iso.slice(11, 16),
    type: p.type?.select?.name ?? "其他",
    title: plain(p.text?.title) || "（无标题）",
    items,
    meal: (MEALS as readonly string[]).includes(meal) ? (meal as Meal) : null,
    categories: (p.categories?.multi_select ?? []).map((o: any) => o.name),
    portion: p.portion?.select?.name ?? null,
    calorie_band: p.calorie_band?.select?.name ?? null,
    kcal: typeof p.kcal?.number === "number" ? p.kcal.number : null,
    protein_g: typeof p.protein_g?.number === "number" ? p.protein_g.number : null,
    fat_g: typeof p.fat_g?.number === "number" ? p.fat_g.number : null,
    carb_g: typeof p.carb_g?.number === "number" ? p.carb_g.number : null,
    bristol: typeof p.bristol?.number === "number" ? p.bristol.number : null,
    flags: (p.flags?.multi_select ?? []).map((o: any) => o.name),
    confidence: typeof p.confidence?.number === "number" ? p.confidence.number : null,
  };
}

/** 某一天在某时区的起止（带偏移的 ISO），给 Notion 的 date 过滤用。 */
export function dayWindow(ymd: string, tz: string): { start: string; end: string } {
  const off = localTime(new Date(`${ymd}T12:00:00Z`), tz).iso.slice(19); // "+08:00"
  return { start: `${ymd}T00:00:00${off}`, end: `${ymd}T23:59:59${off}` };
}

// ---------- 统计 ----------

const isDiet = (e: LogEntry) => e.type === "饮食" || e.type === "咖啡因" || e.type === "酒精";
const isStool = (e: LogEntry) => e.type === "排便";

export function summarize(entries: LogEntry[], date: string, cutoff = "23:59", targets: Targets | null = null): DayStats {
  const sorted = [...entries].sort((a, b) => a.iso.localeCompare(b.iso));
  const diet = sorted.filter(isDiet);
  const stools = sorted.filter(isStool);
  const others = sorted.filter((e) => !isDiet(e) && !isStool(e));

  const meals_eaten = MAIN_MEALS.filter((m) => diet.some((e) => e.meal === m));
  // 到 cutoff 为止"该吃过了"的正餐：早餐 10:30 后、午餐 14:30 后、晚餐 21:30 后才算漏
  const due: Array<[Meal, string]> = [
    ["早餐", "10:30"],
    ["午餐", "14:30"],
    ["晚餐", "21:30"],
  ];
  const meals_missing = diet.length ? due.filter(([m, t]) => cutoff >= t && !meals_eaten.includes(m)).map(([m]) => m) : [];

  const categories: Record<string, number> = {};
  for (const e of diet) for (const c of new Set(e.categories)) categories[c] = (categories[c] ?? 0) + 1;
  const covered = BASIC_GROUPS.filter((g) => (categories[g] ?? 0) > 0);
  const missing_groups = BASIC_GROUPS.filter((g) => !(categories[g] ?? 0));

  const calorie: Record<string, number> = {};
  for (const e of diet) if (e.calorie_band) calorie[e.calorie_band] = (calorie[e.calorie_band] ?? 0) + 1;

  const flags = [...new Set(sorted.flatMap((e) => e.flags))];
  const bristol = stools.map((e) => e.bristol).filter((b): b is number => typeof b === "number");

  const stats: DayStats = {
    date,
    cutoff,
    entries: sorted,
    diet,
    stools,
    others,
    meals_eaten,
    meals_missing,
    snacks: diet.filter((e) => e.meal === "加餐").length,
    late_night: diet.filter((e) => e.meal === "夜宵").length,
    big_portions: diet.filter((e) => e.portion === "大").length,
    calorie,
    categories,
    covered: [...covered],
    missing_groups: [...missing_groups],
    balance_score: diet.length ? covered.length * 20 : null,
    totals: sumMacros(diet),
    targets,
    bristol,
    flags,
    red_flag: flags.includes("带血") || flags.includes("黑便"),
    anomalies: [],
  };
  stats.anomalies = anomaliesOf(stats);
  return stats;
}

/** 异常规则，全部写死；改阈值请附测试。 */
export function anomaliesOf(s: DayStats): string[] {
  const out: string[] = [];
  if (s.red_flag) out.push("排便带血或黑便 → 建议尽快就医");
  for (const b of s.bristol) {
    if (b <= 2) out.push(`排便偏干（Bristol ${b}）`);
    else if (b >= 6) out.push(`排便偏稀（Bristol ${b}）`);
  }
  if (s.meals_missing.length) out.push(`没有${s.meals_missing.join("、")}记录`);
  if (s.late_night) out.push(`夜宵 ${s.late_night} 次`);
  if (s.big_portions >= 2) out.push(`大份 ${s.big_portions} 次`);
  const n = (k: string) => s.categories[k] ?? 0;
  if (n("糖饮")) out.push(`糖饮 ${n("糖饮")} 次`);
  if (n("酒精")) out.push(`酒精 ${n("酒精")} 次`);
  if (n("咖啡因") >= 3) out.push(`咖啡因 ${n("咖啡因")} 次`);
  if (n("油炸") + n("外卖") >= 2) out.push(`油炸/外卖 ${n("油炸") + n("外卖")} 次`);
  if (s.diet.length >= 2 && !n("蔬菜")) out.push("一天没有蔬菜");
  if (s.targets && s.totals.counted && s.totals.kcal > s.targets.kcal * 1.15) out.push(`热量超目标 ${Math.round(s.totals.kcal - s.targets.kcal)} 千卡`);
  return out;
}

// ---------- 给模型 ----------

export const REPORT_SYSTEM_PROMPT = `你是个人健康记录助手，在写用户当天的饮食与排便日报。
你会收到一份程序统计好的 JSON：当天每条记录（时间、餐次、识别出的食物、类别、份量、热量档、Bristol、标记）、类别覆盖、以及按固定规则列出的异常。
规则：
- 只基于给你的数据写，没记录的事不要猜、不要编（比如没有饮水数据就别提饮水）。
- 不做医学诊断、不猜病因、不提具体药物。涉及带血、黑便或持续异常，只说"建议尽快就医"。
- 语气像熟悉的朋友聊天，具体、简短，不说教，不用"您"。
- 只输出一个 JSON 对象，不要 markdown 代码块、不要别的文字：
{"summary": "一句话总结今天，≤40 字", "observations": ["2 到 4 条观察，每条 ≤40 字，先说事实再说含义"], "suggestion": "明天一条可执行的小建议，≤40 字"}`;

export function reportUserPrompt(s: DayStats): string {
  const slim = {
    date: s.date,
    cutoff: s.cutoff,
    records: s.entries.map((e) => ({
      time: e.hm,
      type: e.type,
      meal: e.meal,
      title: e.title,
      items: e.items,
      categories: e.categories,
      portion: e.portion,
      calorie_band: e.calorie_band,
      bristol: e.bristol,
      flags: e.flags,
    })),
    meals_eaten: s.meals_eaten,
    meals_missing: s.meals_missing,
    snacks: s.snacks,
    late_night: s.late_night,
    covered_groups: s.covered,
    missing_groups: s.missing_groups,
    balance_score: s.balance_score,
    intake: s.totals.counted ? { kcal: Math.round(s.totals.kcal), protein_g: Math.round(s.totals.protein_g), fat_g: Math.round(s.totals.fat_g), carb_g: Math.round(s.totals.carb_g), records_without_numbers: s.totals.missing } : null,
    targets: s.targets,
    stool_count: s.stools.length,
    bristol: s.bristol,
    anomalies: s.anomalies,
  };
  return `这是 ${s.date} 的数据（统计截至 ${s.cutoff}）：\n${JSON.stringify(slim, null, 0)}`;
}

/** 模型输出校验；解析失败就用规则生成的兜底文案，日报照样发。 */
export function parseNarrative(raw: string, s: DayStats): Narrative {
  const fallback = fallbackNarrative(s);
  try {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const o = JSON.parse(text);
    const summary = typeof o.summary === "string" && o.summary.trim() ? o.summary.trim().slice(0, 120) : fallback.summary;
    const observations = Array.isArray(o.observations)
      ? o.observations.filter((x: unknown) => typeof x === "string" && (x as string).trim()).map((x: string) => x.trim().slice(0, 120)).slice(0, 4)
      : [];
    const suggestion = typeof o.suggestion === "string" && o.suggestion.trim() ? o.suggestion.trim().slice(0, 120) : fallback.suggestion;
    return { summary, observations: observations.length ? observations : fallback.observations, suggestion, from_model: true };
  } catch {
    return fallback;
  }
}

export function fallbackNarrative(s: DayStats): Narrative {
  const summary = s.diet.length
    ? `记录了 ${s.meals_eaten.length} 顿正餐${s.late_night ? `、${s.late_night} 次夜宵` : ""}，五大类覆盖 ${s.covered.length}/5，排便 ${s.stools.length} 次。`
    : `今天没有饮食记录，排便 ${s.stools.length} 次。`;
  const observations = s.anomalies.length ? s.anomalies.slice(0, 4) : ["没有触发任何异常规则。"];
  const suggestion = s.missing_groups.length ? `明天补上${s.missing_groups.slice(0, 2).join("和")}。` : "继续保持，每顿都拍一下。";
  return { summary, observations, suggestion, from_model: false };
}

// ---------- 输出：推送文案 + Notion 页面 ----------

export function pushText(s: DayStats, n: Narrative): { title: string; body: string } {
  const md = s.date.slice(5).replace("-", "/");
  const score = s.balance_score === null ? "" : ` · 均衡度 ${s.balance_score}`;
  const title = `${s.red_flag ? "⚠️ " : ""}日报 ${md}${score}`;
  const body = [n.summary, n.suggestion ? `明天：${n.suggestion}` : ""].filter(Boolean).join("\n");
  return { title, body };
}

const txt = (content: string) => ({ type: "text", text: { content: content.slice(0, 1900) } });
const mention = (id: string) => ({ type: "mention", mention: { page: { id } } });
const block = (type: string, rich_text: any[], extra: Record<string, any> = {}) => ({ object: "block", type, [type]: { rich_text, ...extra } });
const h2 = (t: string) => block("heading_2", [txt(t)]);
const bullet = (rt: any[]) => block("bulleted_list_item", rt);
const para = (t: string) => block("paragraph", [txt(t)]);

/** 一行一条记录：时间 · 餐次 · [页面 mention（标题）] · 份量/热量档 · 标记。mention 会显示页面标题，所以不再重复写食物。 */
function entryLine(e: LogEntry): any[] {
  const head = [e.hm, e.meal].filter(Boolean).join(" · ");
  const tail = [[e.portion, e.calorie_band].filter(Boolean).join("/"), e.kcal !== null ? `约 ${e.kcal} 千卡` : "", e.flags.join(" ")].filter(Boolean).join(" · ");
  const rt: any[] = [txt(`${head} · `)];
  rt.push(e.id ? mention(e.id) : txt(e.items.length ? e.items.join("、") : e.title));
  if (tail) rt.push(txt(` · ${tail}`));
  return rt;
}

function stoolLine(e: LogEntry): any[] {
  const tail = [`Bristol ${e.bristol ?? "?"}`, e.flags.join(" ")].filter(Boolean).join(" · ");
  const rt: any[] = [txt(`${e.hm} · `)];
  rt.push(e.id ? mention(e.id) : txt(e.title));
  rt.push(txt(` · ${tail}`));
  return rt;
}

export function reportBlocks(s: DayStats, n: Narrative, model: string): any[] {
  const out: any[] = [];
  out.push(h2("一句话"));
  out.push(para(n.summary));

  out.push(h2("今天吃了什么"));
  if (s.diet.length) for (const e of s.diet) out.push(bullet(entryLine(e)));
  else out.push(para("没有饮食记录。"));

  out.push(h2("排便"));
  if (s.stools.length) for (const e of s.stools) out.push(bullet(stoolLine(e)));
  else out.push(para("没有排便记录。"));

  if (s.others.length) {
    out.push(h2("其他记录"));
    for (const e of s.others) out.push(bullet([txt(`${e.hm} · ${e.type} · `), e.id ? mention(e.id) : txt(e.title)]));
  }

  out.push(h2("统计"));
  const mealsLine = s.meals_eaten.length ? `正餐：${s.meals_eaten.join("、")}` : "正餐：无记录";
  const extra = [s.snacks ? `加餐 ${s.snacks}` : "", s.late_night ? `夜宵 ${s.late_night}` : ""].filter(Boolean).join("，");
  out.push(bullet([txt(extra ? `${mealsLine}（${extra}）` : mealsLine)]));
  out.push(bullet([txt(`五大类：${BASIC_GROUPS.map((g) => `${g}${s.covered.includes(g) ? "✓" : "✗"}`).join(" ")}`)]));
  const watch = WATCH_GROUPS.map((g) => [g, s.categories[g] ?? 0] as const).filter(([, c]) => c > 0);
  if (watch.length) out.push(bullet([txt(`留意：${watch.map(([g, c]) => `${g} ${c}`).join("，")}`)]));
  if (s.totals.counted) {
    const t = s.totals;
    const g = s.targets;
    out.push(bullet([txt(`摄入：约 ${Math.round(t.kcal)} 千卡${g ? ` / 目标 ${g.kcal}` : ""} · 蛋白 ${Math.round(t.protein_g)}g${g ? `/${g.protein_g}` : ""} · 脂肪 ${Math.round(t.fat_g)}g${g ? `/${g.fat_g}` : ""} · 碳水 ${Math.round(t.carb_g)}g${g ? `/${g.carb_g}` : ""}${t.missing ? `（${t.missing} 条老记录没数字）` : ""}`)]));
  }
  const cal = Object.entries(s.calorie);
  if (cal.length) out.push(bullet([txt(`热量档：${cal.map(([k, v]) => `${k} ${v}`).join("，")}`)]));
  out.push(bullet([txt(s.balance_score === null ? "均衡度：—（没有饮食记录）" : `均衡度：${s.balance_score}/100（五大类覆盖 ${s.covered.length} × 20）`)]));
  out.push(bullet([txt(s.anomalies.length ? `异常：${s.anomalies.join("；")}` : "异常：无")]));

  out.push(h2("点评"));
  for (const o of n.observations) out.push(bullet([txt(o)]));

  out.push(h2("明天试试"));
  out.push(para(n.suggestion));

  if (s.red_flag) out.push(block("callout", [txt("记录里出现了带血或黑便的标记。建议尽快就医，这不是诊断。")], { icon: { type: "emoji", emoji: "⚠️" }, color: "red_background" }));
  out.push(
    block("callout", [txt(`统计截至 ${s.cutoff}，之后的记录仍在记录库里，可随时重跑。数字全部来自记录库的字段，不是模型估算；点评由 ${n.from_model ? model : "规则兜底"} 生成，不是医疗建议。`)], {
      icon: { type: "emoji", emoji: "ℹ️" },
      color: "gray_background",
    }),
  );
  return out;
}

export function reportProps(s: DayStats, n: Narrative, model: string): Record<string, any> {
  const rich = (t: string) => ({ rich_text: [txt(t)] });
  const raw = JSON.stringify({ narrative: n, anomalies: s.anomalies, meals_eaten: s.meals_eaten, covered: s.covered, categories: s.categories, bristol: s.bristol, flags: s.flags, entries: s.entries.map((e) => e.id) });
  const p: Record<string, any> = {
    date: { title: [txt(s.date)] },
    type: { select: { name: "日报" } },
    summary: rich(n.summary),
    suggestion: rich(n.suggestion),
    anomalies: rich(s.anomalies.join("；")),
    model: rich(n.from_model ? model : "rules"),
    raw_json: rich(raw),
    meals: { number: s.meals_eaten.length },
    stools: { number: s.stools.length },
  };
  if (s.balance_score !== null) p.status_score = { number: s.balance_score };
  if (s.flags.length) p.flags = { multi_select: s.flags.map((name) => ({ name })) };
  if (s.totals.counted) {
    p.kcal = { number: Math.round(s.totals.kcal) };
    p.protein_g = { number: Math.round(s.totals.protein_g) };
    p.fat_g = { number: Math.round(s.totals.fat_g) };
    p.carb_g = { number: Math.round(s.totals.carb_g) };
  }
  return p;
}
