// Cliente do Ollama (https://ollama.com): modelos de IA abertos rodando de
// graça no computador onde este servidor está. Usa a API HTTP local do Ollama.

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
// Contexto maior que o padrão do Ollama: a coleção inteira precisa caber no prompt.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX) || 32768;

export class OllamaError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function ollamaFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(OLLAMA_URL + path, options);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new OllamaError(
      `Ollama não encontrado em ${OLLAMA_URL}. Instale em ollama.com, abra o programa e baixe um modelo (ex.: "ollama pull qwen2.5vl").`,
      503,
    );
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new OllamaError(`Erro do Ollama: ${data.error || res.status}`, res.status === 404 ? 404 : 502);
  }
  return res;
}

const visionCache = new Map();

async function supportsVision(model) {
  if (!visionCache.has(model)) {
    const res = await ollamaFetch("/api/show", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const info = await res.json();
    const caps = info.capabilities || [];
    const vision = caps.includes("vision") || Boolean(info.projector_info);
    visionCache.set(model, vision);
  }
  return visionCache.get(model);
}

export async function listModels() {
  const res = await ollamaFetch("/api/tags");
  const data = await res.json();
  const models = (data.models || []).map((m) => m.name);
  const withVision = await Promise.all(
    models.map(async (name) => ({ name, vision: await supportsVision(name).catch(() => false) })),
  );
  return withVision.filter((m) => !/embed/i.test(m.name));
}

export async function ensureModel(model) {
  if (!model) throw new OllamaError("Escolha um modelo do Ollama.", 400);
  const models = await listModels();
  if (!models.some((m) => m.name === model)) {
    throw new OllamaError(`O modelo "${model}" não está instalado no Ollama. Rode: ollama pull ${model}`, 404);
  }
}

// Converte o conteúdo no formato da API do Claude (blocos de texto/imagem)
// para o formato do Ollama (um texto + lista de imagens em base64).
function toOllamaMessage(content, vision) {
  if (typeof content === "string") return { role: "user", content };
  const parts = [];
  const images = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image" && vision) {
      images.push(block.source.data);
      parts.push(`[imagem ${images.length} anexada]`);
    }
  }
  return { role: "user", content: parts.join("\n\n"), ...(images.length ? { images } : {}) };
}

export async function streamOllama({ model, system, content, onText, signal }) {
  const vision = await supportsVision(model);
  const res = await ollamaFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      stream: true,
      options: { num_ctx: NUM_CTX },
      messages: [{ role: "system", content: system }, toOllamaMessage(content, vision)],
    }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const data = JSON.parse(line);
    if (data.error) throw new OllamaError(`Erro do Ollama: ${data.error}`);
    if (data.message?.content) onText(data.message.content);
    if (data.done) last = data;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  handle(buffer);
  if (last?.done_reason === "length") {
    onText("\n\n> ⚠️ Resposta interrompida pelo limite de tamanho. Tente pedir menos conteúdos ou analisar menos posts.");
  }
  return { vision };
}

export { OLLAMA_URL };
