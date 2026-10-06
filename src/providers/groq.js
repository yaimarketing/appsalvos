// Groq (https://groq.com): modelos abertos (Llama, Qwen etc.) muito rápidos,
// com plano gratuito limitado. API compatível com o formato da OpenAI.
import { ProviderError, httpError, readSSE, limitImages, TRUNCATED_NOTE } from "./common.js";

const BASE = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
// A Groq aceita no máximo 5 imagens por requisição nos modelos com visão.
const MAX_IMAGES = 5;

export const info = {
  id: "groq",
  label: "Groq",
  of: "da Groq",
  paid: false,
  needsKey: true,
  envKey: "GROQ_API_KEY",
  keyPattern: /^gsk_[\w-]+$/,
  keyUrl: "https://console.groq.com/keys",
};

const PREFERRED = [
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.3-70b-versatile",
];

const isVision = (id) => /llama-4|vision|-vl|scout|maverick/i.test(id);
const isChatModel = (id) => !/whisper|tts|guard|embed|playai|orpheus|prompt-guard|safeguard/i.test(id);

async function groqFetch(path, apiKey, options = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      ...options,
      headers: { Authorization: `Bearer ${apiKey}`, ...(options.headers || {}) },
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ProviderError("Não foi possível conectar à Groq.", 503);
  }
  if (!res.ok) throw await httpError(res, "da Groq");
  return res;
}

export async function validateKey(apiKey) {
  await groqFetch("/models", apiKey);
}

export async function listModels(apiKey) {
  const data = await (await groqFetch("/models", apiKey)).json();
  const models = (data.data || [])
    .filter((m) => m.active !== false && isChatModel(m.id))
    .map((m) => ({ id: m.id, label: m.id, vision: isVision(m.id) }));
  const rank = (id) => {
    const i = PREFERRED.indexOf(id);
    return i < 0 ? PREFERRED.length : i;
  };
  return models.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

function toOpenAIContent(content, vision) {
  if (typeof content === "string") return content;
  return limitImages(content, vision ? MAX_IMAGES : 0).map((b) =>
    b.type === "image"
      ? { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
      : { type: "text", text: b.text },
  );
}

export async function stream({ apiKey, model, system, content, onText, signal }) {
  const res = await groqFetch("/chat/completions", apiKey, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: toOpenAIContent(content, isVision(model)) },
      ],
    }),
  });
  let finish = null;
  await readSSE(res.body, (data) => {
    if (data.error) throw new ProviderError(`Erro da Groq: ${data.error.message || "desconhecido"}`);
    const choice = data.choices?.[0];
    if (choice?.delta?.content) onText(choice.delta.content);
    if (choice?.finish_reason) finish = choice.finish_reason;
  });
  if (finish === "length") onText(TRUNCATED_NOTE);
}

// Transcrição de áudio com Whisper hospedado na Groq (rápido, plano gratuito).
export async function transcribe(apiKey, audioBuffer, filename = "audio.mp3") {
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: "audio/mpeg" }), filename);
  form.append("model", process.env.GROQ_WHISPER_MODEL || "whisper-large-v3-turbo");
  form.append("language", process.env.GROQ_WHISPER_LANGUAGE || "pt");
  form.append("response_format", "json");
  const res = await groqFetch("/audio/transcriptions", apiKey, { method: "POST", body: form });
  const data = await res.json();
  return String(data.text || "").trim();
}
