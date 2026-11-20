import { test } from "node:test";
import assert from "node:assert/strict";
import { sttConfigFromEnv, cleanTranscript, parseTranscriptResponse, audioFilename, buildTranscriptionForm, DEFAULT_STT_BASE_URL, DEFAULT_STT_MODEL, DEFAULT_STT_PROMPT, SttError } from "./stt.ts";

test("没有 STT_API_KEY 就关闭；有 key 用 Groq 默认值", () => {
  assert.equal(sttConfigFromEnv({}), null);
  assert.equal(sttConfigFromEnv({ STT_API_KEY: "  " }), null);
  const c = sttConfigFromEnv({ STT_API_KEY: "gsk_x" })!;
  assert.equal(c.baseUrl, DEFAULT_STT_BASE_URL);
  assert.equal(c.model, DEFAULT_STT_MODEL);
  assert.equal(c.prompt, DEFAULT_STT_PROMPT);
  assert.equal(c.language, undefined);
});

test("可以换成 OpenAI 等同类接口，并强制语言 / 关掉提示词", () => {
  const c = sttConfigFromEnv({ STT_API_KEY: "sk", STT_BASE_URL: "https://api.openai.com/v1/", STT_MODEL: "gpt-4o-mini-transcribe", STT_LANGUAGE: "zh", STT_PROMPT: "" })!;
  assert.equal(c.baseUrl, "https://api.openai.com/v1"); // 去掉末尾斜杠
  assert.equal(c.model, "gpt-4o-mini-transcribe");
  assert.equal(c.language, "zh");
  assert.equal(c.prompt, undefined);
});

test("清洗：空白、中文间空格、幻听套话", () => {
  assert.equal(cleanTranscript("  中午 吃了 一碗 牛肉面 ， 还有 两个 鸡蛋 "), "中午吃了一碗牛肉面，还有两个鸡蛋");
  assert.equal(cleanTranscript("TSLA 今天 怎么样"), "TSLA 今天怎么样"); // 英文和中文之间的空格保留
  assert.equal(cleanTranscript(""), "");
  assert.equal(cleanTranscript("请不吝点赞 订阅 转发 打赏支持明镜与点点栏目"), "");
  assert.equal(cleanTranscript("字幕由Amara.org社区提供"), "");
  assert.equal(cleanTranscript("谢谢观看"), "");
  assert.equal(cleanTranscript("谢谢你帮我记一下"), "谢谢你帮我记一下"); // 正常句子不能误杀
});

test("解析接口返回", () => {
  assert.equal(parseTranscriptResponse({ text: "你好" }), "你好");
  assert.equal(parseTranscriptResponse({}), "");
  assert.equal(parseTranscriptResponse(null), "");
});

test("Telegram 的 .oga 统一成 ogg，其他格式照旧", () => {
  assert.deepEqual(audioFilename("oga"), { name: "voice.ogg", type: "audio/ogg" });
  assert.deepEqual(audioFilename(".OGG"), { name: "voice.ogg", type: "audio/ogg" });
  assert.deepEqual(audioFilename("m4a"), { name: "voice.m4a", type: "audio/mp4" });
  assert.equal(audioFilename("mp3").type, "audio/mpeg");
});

test("multipart 表单字段", async () => {
  const cfg = sttConfigFromEnv({ STT_API_KEY: "k", STT_LANGUAGE: "zh" })!;
  const form = buildTranscriptionForm(new Uint8Array([1, 2, 3]), "oga", cfg);
  assert.equal(form.get("model"), DEFAULT_STT_MODEL);
  assert.equal(form.get("response_format"), "json");
  assert.equal(form.get("temperature"), "0");
  assert.equal(form.get("language"), "zh");
  assert.equal(form.get("prompt"), DEFAULT_STT_PROMPT);
  const file = form.get("file") as File;
  assert.equal(file.name, "voice.ogg");
  assert.equal(file.type, "audio/ogg");
  assert.equal(file.size, 3);
});

test("错误翻译成人话", () => {
  assert.match(new SttError(401, "x").human(), /key/);
  assert.match(new SttError(429, "x").human(), /上限/);
  assert.match(new SttError(503, "x").human(), /不可用/);
});
