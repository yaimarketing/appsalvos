// Google Gemini (https://ai.google.dev): modelos multimodais com plano gratuito
// limitado. No plano gratuito o Google pode usar os dados para melhorar produtos.
import { ProviderError, httpError, readSSE, TRUNCATED_NOTE } from "./common.js";

const BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";

export const info = {
  id: "gemini",
  label: "Gemini",
  of: "do Gemini",
  paid: false,
  needsKey: true,
  envKey: "GEMINI_API_KEY",
  keyPattern: /^[\w-]{30,}$/,
  keyUrl: "https://aistudio.google.com/apikey",
};

async function geminiFetch(path, apiKey, options = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      ...options,
      headers: { "x-goog-api-key": apiKey, ...(options.headers || {}) },
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ProviderError("Não foi possível conectar ao Gemini.", 503);
  }
  if (!res.ok) {
    // O Gemini responde 400 (API_KEY_INVALID) para chave errada.
    const err = await httpError(res, "do Gemini");
    if (/API key not valid|API_KEY_INVALID/i.test(err.message)) {
      throw new ProviderError("Chave do Gemini inválida. Conecte novamente.", 401);
    }
    throw err;
  }
  return res;
}

export async function validateKey(apiKey) {
  await geminiFetch("/models?pageSize=1", apiKey);
}

export async function listModels(apiKey) {
  const models = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const data = await (await geminiFetch(`/models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`, apiKey)).json();
    for (const m of data.models || []) {
      const id = String(m.name || "").replace(/^models\//, "");
      const methods = m.supportedGenerationMethods || [];
      if (!methods.includes("generateContent") || !/^gemini/.test(id)) continue;
      if (/embedding|image-generation|tts|live|audio|aqa|robotics|computer-use/i.test(id)) continue;
      models.push({ id, label: m.displayName ? `${m.displayName} (${id})` : id, vision: true });
    }
    if (!data.nextPageToken) break;
    pageToken = encodeURIComponent(data.nextPageToken);
  }
  // Modelos "flash" primeiro: são os mais generosos no plano gratuito.
  const score = (id) => (/flash/.test(id) && !/lite/.test(id) ? 0 : /flash/.test(id) ? 1 : 2) + (/preview|exp/.test(id) ? 3 : 0);
  return models.sort((a, b) => score(a.id) - score(b.id) || b.id.localeCompare(a.id));
}

function toGeminiParts(content) {
  if (typeof content === "string") return [{ text: content }];
  return content.map((b) =>
    b.type === "image"
      ? { inline_data: { mime_type: b.source.media_type, data: b.source.data } }
      : { text: b.text },
  );
}

export async function stream({ apiKey, model, system, content, onText, signal }) {
  const res = await geminiFetch(`/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, apiKey, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: toGeminiParts(content) }],
    }),
  });
  let finish = null;
  await readSSE(res.body, (data) => {
    if (data.error) throw new ProviderError(`Erro do Gemini: ${data.error.message || "desconhecido"}`);
    if (data.promptFeedback?.blockReason) {
      throw new ProviderError(`O Gemini bloqueou a solicitação (${data.promptFeedback.blockReason}).`, 400);
    }
    const cand = data.candidates?.[0];
    for (const part of cand?.content?.parts || []) {
      if (part.text && !part.thought) onText(part.text);
    }
    if (cand?.finishReason) finish = cand.finishReason;
  });
  if (finish === "MAX_TOKENS") onText(TRUNCATED_NOTE);
  else if (finish && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(finish)) {
    throw new ProviderError(`O Gemini interrompeu a resposta (${finish}).`, 400);
  }
}
