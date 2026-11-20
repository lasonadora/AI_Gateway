// 语音转文字（Telegram 语音条 → 文本）。走 OpenAI 兼容的 /audio/transcriptions，默认 Groq 的 Whisper large-v3-turbo：
// 中文识别好、快（一条语音 1–2 秒）、便宜（$0.04 / 小时，按 10 秒起计）。换 OpenAI 等同类服务只需改 STT_BASE_URL / STT_MODEL。
// 纯逻辑（配置解析、结果清洗）在这里并有测试；网络调用也在这里但不做单测。

export interface SttConfig {
  apiKey: string;
  baseUrl: string; // 形如 https://api.groq.com/openai/v1
  model: string;
  language?: string; // ISO-639-1，比如 zh；不填让模型自己判断（中英混说更稳）
  prompt?: string; // 风格 / 用词提示，≤224 token
}

export const DEFAULT_STT_BASE_URL = "https://api.groq.com/openai/v1";
export const DEFAULT_STT_MODEL = "whisper-large-v3-turbo";
/** 用简体中文给提示，Whisper 就倾向输出简体而不是繁体；顺带教它几个常说的英文词。 */
export const DEFAULT_STT_PROMPT = "以下是普通话的日常语音，可能夹杂英文词，比如 Notion、TSLA、ASML、QQQ、agent。";
export const MAX_VOICE_SECONDS = 300;

/** 从环境变量拼配置；没有 key 就返回 null（功能关闭）。 */
export function sttConfigFromEnv(e: Record<string, string | undefined>): SttConfig | null {
  const apiKey = (e.STT_API_KEY ?? "").trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (e.STT_BASE_URL || DEFAULT_STT_BASE_URL).replace(/\/+$/, ""),
    model: e.STT_MODEL || DEFAULT_STT_MODEL,
    language: (e.STT_LANGUAGE ?? "").trim() || undefined,
    prompt: e.STT_PROMPT === undefined ? DEFAULT_STT_PROMPT : e.STT_PROMPT.trim() || undefined,
  };
}

// Whisper 对着静音 / 杂音会"幻听"出这些训练数据里的套话，整条都是这种就当没听到。
const HALLUCINATIONS = [/明镜与点点栏目/, /点赞.*订阅/, /字幕由.*提供/, /Amara\.org/i, /^谢谢(大家)?(观看|收看)[。！!]?$/, /^请不吝/, /^字幕/, /^\[?(音乐|Music|BLANK_AUDIO)\]?$/i];

/** 去掉多余空白、幻听套话；返回空串表示没听到有效内容。 */
export function cleanTranscript(raw: string): string {
  let t = (raw ?? "").replace(/\s+/g, " ").trim();
  // 中文之间不需要空格（Whisper 有时按词切）
  t = t.replace(/([一-鿿，。！？、；：])\s+(?=[一-鿿，。！？、；：])/g, "$1");
  if (!t) return "";
  if (HALLUCINATIONS.some((re) => re.test(t))) return "";
  return t;
}

/** 解析 response_format=json 的返回：{ text } */
export function parseTranscriptResponse(json: unknown): string {
  const text = (json as any)?.text;
  return typeof text === "string" ? text : "";
}

/** Telegram 语音条下载下来是 .oga；接口按扩展名认格式，统一成 ogg。 */
export function audioFilename(ext: string): { name: string; type: string } {
  const e = (ext || "").toLowerCase().replace(/^\./, "");
  if (e === "oga" || e === "ogg" || e === "opus" || e === "") return { name: "voice.ogg", type: "audio/ogg" };
  if (e === "m4a" || e === "mp4") return { name: `voice.${e}`, type: "audio/mp4" };
  if (e === "mp3" || e === "mpga" || e === "mpeg") return { name: "voice.mp3", type: "audio/mpeg" };
  if (e === "wav") return { name: "voice.wav", type: "audio/wav" };
  if (e === "webm") return { name: "voice.webm", type: "audio/webm" };
  if (e === "flac") return { name: "voice.flac", type: "audio/flac" };
  return { name: `voice.${e}`, type: "application/octet-stream" };
}

/** 组 multipart 表单（单独拆出来方便测）。 */
export function buildTranscriptionForm(buf: Uint8Array, ext: string, cfg: SttConfig): FormData {
  const f = audioFilename(ext);
  const form = new FormData();
  form.append("file", new Blob([buf as BlobPart], { type: f.type }), f.name);
  form.append("model", cfg.model);
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (cfg.language) form.append("language", cfg.language);
  if (cfg.prompt) form.append("prompt", cfg.prompt);
  return form;
}

export class SttError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`语音识别接口 ${status}: ${body.slice(0, 160)}`);
    this.status = status;
  }
  human(): string {
    if (this.status === 401 || this.status === 403) return "语音识别的 key 不对或过期了（STT_API_KEY）";
    if (this.status === 429) return "语音识别额度/频率到上限了，等一会儿再试";
    if (this.status === 413) return "这条语音太大了";
    if (this.status >= 500) return "语音识别服务暂时不可用";
    return this.message;
  }
}

/** 把一段音频转成文字；网络错误 / 非 2xx 抛 SttError，内容空（没听到）返回 ""。 */
export async function transcribe(buf: Uint8Array, ext: string, cfg: SttConfig, timeoutMs = 60_000): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    body: buildTranscriptionForm(buf, ext, cfg),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new SttError(res.status, text);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SttError(res.status, `不是 JSON：${text}`);
  }
  return cleanTranscript(parseTranscriptResponse(json));
}
