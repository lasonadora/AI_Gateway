// 拍照记录的纯逻辑：餐次判定、给视觉模型的提示词、模型输出的校验。
// 不碰网络、不碰 Notion，方便用 node:test 测。数字和分类规则在这里，模型只负责"看图"。

export const CATEGORIES = ["主食", "蛋白", "蔬菜", "水果", "乳制品", "糖饮", "酒精", "咖啡因", "零食", "油炸", "外卖"] as const;
export const FLAGS = ["带血", "黑便", "腹泻", "便秘", "颜色异常", "夜宵", "大份"] as const;
export const MEALS = ["早餐", "午餐", "晚餐", "加餐", "夜宵"] as const;

export type Kind = "meal" | "drink" | "stool" | "other";
export type Meal = (typeof MEALS)[number];

export interface Analysis {
  kind: Kind;
  title: string; // 短标题，写进 Notion 的 title
  items: string[]; // 饮食/饮品：识别出的食物
  categories: string[]; // 饮食：类别（只保留 CATEGORIES 里的）
  portion: "小" | "中" | "大" | null;
  calorie_band: "轻" | "中" | "重" | null;
  bristol: number | null; // 排便：1-7
  flags: string[]; // 只保留 FLAGS 里的
  confidence: number; // 0-1
  notes: string; // 给人看的一两句话
  red_flag: boolean; // 带血/黑便等，需要就医
}

/** 本地时间（小时+分钟）→ 餐次。规则写死在代码里，不让模型猜。 */
export function mealSlot(hour: number, minute = 0): Meal {
  const t = hour + minute / 60;
  if (t >= 5 && t < 10.5) return "早餐";
  if (t >= 10.5 && t < 14.5) return "午餐";
  if (t >= 17 && t < 21.5) return "晚餐";
  if (t >= 21.5 || t < 5) return "夜宵";
  return "加餐";
}

/** 把 Date 拆成某时区的本地时间分量，并给出带时区偏移的 ISO 字符串（Notion 需要）。 */
export function localTime(d: Date, tz: string): { iso: string; hour: number; minute: number; ymd: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  let off = get("timeZoneName").replace("GMT", ""); // "+08:00" / "" (UTC)
  if (!off) off = "+00:00";
  if (/^[+-]\d{2}$/.test(off)) off = `${off}:00`;
  const iso = `${ymd}T${String(hour).padStart(2, "0")}:${get("minute")}:${get("second")}${off}`;
  return { iso, hour, minute, ymd };
}

export const SYSTEM_PROMPT = `你是个人健康记录助手。用户用手机拍了一张照片发给你，照片只可能是四种之一：一顿饭/食物（meal）、一杯饮品（drink）、马桶里的大便（stool）、或者都不是（other）。
你的任务是看图并只输出一个 JSON 对象，不要输出任何其他文字、不要用 markdown 代码块。

JSON 字段（全部必填，不适用的填 null 或空数组）：
{
  "kind": "meal" | "drink" | "stool" | "other",
  "title": "中文短标题，不超过 20 字。饭：主要食物，如「牛肉面 + 青菜」；饮品：如「冰美式」；排便：如「排便 · Bristol 4」；其他：「未识别」",
  "items": ["识别出的食物或饮品，中文，每项不超过 8 字"],
  "categories": ["只能从这个列表里选：${CATEGORIES.join("、")}"],
  "portion": "小" | "中" | "大" | null,
  "calorie_band": "轻" | "中" | "重" | null,
  "bristol": 1 到 7 的整数 | null,
  "flags": ["只能从这个列表里选：${FLAGS.join("、")}"],
  "confidence": 0 到 1 的小数,
  "notes": "给用户看的一两句中文，客观描述你看到的，不说教",
  "red_flag": true | false
}

规则：
- items 要把画面里每一样吃的都列出来（主菜、配菜、主食、汤、饮料、酱料都算），中式菜名用常见叫法。
- categories 必须覆盖 items 里的每一样：米饭/面/馒头/饺子/面包/粉 → 主食；肉/鱼/虾/蛋/豆腐/火腿/香肠 → 蛋白；叶菜/根茎/菌菇 → 蔬菜；水果 → 水果；奶/酸奶/奶酪 → 乳制品；含糖饮料/奶茶/果汁 → 糖饮；咖啡/浓茶/能量饮料 → 咖啡因；酒 → 酒精；薯片/糕点/糖果 → 零食；油炸或明显重油 → 油炸；外卖包装/一次性餐盒 → 外卖。一样东西可以同时属于多个类别。
- portion 以一个成年人一餐的量为"中"。calorie_band：轻 ≈ 400 千卡以下，中 ≈ 400–800，重 ≈ 800 以上，只是粗档位；主食和油多就往上走。
- 「夜宵」「大份」这两个 flag 不要你判断：夜宵由时间决定，大份只在 portion 为「大」时由系统加。
- 排便用 Bristol 分型：1 硬球状难排、2 结块香肠状、3 香肠状表面有裂纹、4 光滑柔软香肠状（理想）、5 软团块边缘清楚、6 糊状边缘不清、7 水样无固体。
- 排便 flags：看到鲜红或暗红 → 「带血」；柏油样黑亮 → 「黑便」；6 或 7 型 → 「腹泻」；1 或 2 型 → 「便秘」；灰白、陶土色、明显绿色 → 「颜色异常」。
- 「带血」或「黑便」时 red_flag = true，notes 里说明"建议尽快就医"。其余 red_flag = false。
- 看不清、不确定就降低 confidence，不要编造。照片既不是食物也不是排便时 kind = "other"，其他字段填 null / 空数组。
- 不做医疗诊断，不给治疗建议。`;

export function userPrompt(localIso: string, note?: string): string {
  const extra = note?.trim() ? `\n用户附带的说明：${note.trim()}` : "";
  return `拍摄时间（本地）：${localIso}${extra}\n请只输出 JSON。`;
}

/** 从模型回复里抠出 JSON 并校验、归一化。不合法的字段丢掉而不是报错。 */
export function parseAnalysis(raw: string): Analysis {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON");
  const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;

  const kinds: Kind[] = ["meal", "drink", "stool", "other"];
  const kind = kinds.includes(obj.kind as Kind) ? (obj.kind as Kind) : "other";
  const strArr = (v: unknown, allow?: readonly string[]) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter((s) => s && (!allow || allow.includes(s))) : [];
  const oneOf = <T extends string>(v: unknown, allow: readonly T[]): T | null => (allow.includes(v as T) ? (v as T) : null);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  let bristol = num(obj.bristol);
  bristol = bristol === null ? null : Math.min(7, Math.max(1, Math.round(bristol)));
  let confidence = num(obj.confidence) ?? 0.5;
  confidence = Math.min(1, Math.max(0, confidence));

  // 「夜宵」「大份」由代码按时间/份量决定，模型给的一律丢掉
  const flags = strArr(obj.flags, FLAGS).filter((f) => f !== "夜宵" && f !== "大份");
  const red = obj.red_flag === true || flags.includes("带血") || flags.includes("黑便");

  const a: Analysis = {
    kind,
    title: typeof obj.title === "string" && obj.title.trim() ? obj.title.trim().slice(0, 40) : kind === "other" ? "未识别" : kind === "stool" ? "排便" : "饮食",
    items: strArr(obj.items).slice(0, 12),
    categories: kind === "meal" || kind === "drink" ? strArr(obj.categories, CATEGORIES) : [],
    portion: kind === "meal" || kind === "drink" ? oneOf(obj.portion, ["小", "中", "大"] as const) : null,
    calorie_band: kind === "meal" || kind === "drink" ? oneOf(obj.calorie_band, ["轻", "中", "重"] as const) : null,
    bristol: kind === "stool" ? bristol : null,
    flags,
    confidence,
    notes: typeof obj.notes === "string" ? obj.notes.trim().slice(0, 500) : "",
    red_flag: red,
  };
  // 排便自动补 flags（和 Bristol 一致），代码说了算
  if (a.kind === "stool" && a.bristol !== null) {
    if (a.bristol >= 6 && !a.flags.includes("腹泻")) a.flags.push("腹泻");
    if (a.bristol <= 2 && !a.flags.includes("便秘")) a.flags.push("便秘");
  }
  if ((a.kind === "meal" || a.kind === "drink") && a.portion === "大") a.flags.push("大份");
  return a;
}

/** Notion 的 type 选项：饮品按内容归到 酒精 / 咖啡因，其余饮食 */
export function notionType(kind: Kind, categories: string[] = []): "饮食" | "排便" | "酒精" | "咖啡因" | "其他" {
  if (kind === "drink") {
    if (categories.includes("酒精")) return "酒精";
    if (categories.includes("咖啡因")) return "咖啡因";
    return "饮食";
  }
  if (kind === "meal") return "饮食";
  if (kind === "stool") return "排便";
  return "其他";
}

/** Notion 页面图标 */
export function iconFor(kind: Kind): string {
  return kind === "stool" ? "🚽" : kind === "drink" ? "🥤" : kind === "meal" ? "🍽️" : "📷";
}
