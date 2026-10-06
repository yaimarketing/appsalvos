// Utilidades compartilhadas pelos provedores de IA.

export class ProviderError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// Lê o corpo de uma resposta linha a linha (NDJSON ou SSE).
export async function readLines(body, onLine) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      onLine(line);
    }
  }
  if (buffer) onLine(buffer);
}

// Eventos SSE "data: {...}" → objetos JSON.
export function readSSE(body, onData) {
  return readLines(body, (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    onData(JSON.parse(payload));
  });
}

// Converte respostas de erro HTTP em mensagens úteis para a tela.
// `of` é o nome com a preposição certa: "da Groq", "do Gemini".
export async function httpError(res, of) {
  const data = await res.json().catch(() => ({}));
  const detail = data.error?.message || data.error || data.message || "";
  const msg = typeof detail === "string" ? detail : JSON.stringify(detail);
  if (res.status === 401 || res.status === 403) {
    return new ProviderError(`Chave ${of} inválida ou sem permissão. Conecte novamente.`, 401);
  }
  if (res.status === 413) {
    return new ProviderError(
      `A coleção ficou grande demais para o plano ${of}. Reduza o número de posts ou de imagens.`,
      413,
    );
  }
  if (res.status === 429) {
    return new ProviderError(
      `Limite de uso ${of} atingido (plano gratuito tem limite por minuto/dia). Aguarde um pouco ou reduza posts e imagens.${msg ? ` Detalhe: ${msg}` : ""}`,
      429,
    );
  }
  return new ProviderError(`Erro ${of} (${res.status})${msg ? `: ${msg}` : ""}`, res.status >= 500 ? 502 : 400);
}

export const TRUNCATED_NOTE =
  "\n\n> ⚠️ Resposta interrompida pelo limite de tamanho. Tente pedir menos conteúdos ou analisar menos posts.";

// Remove imagens (para modelos sem visão) ou limita a quantidade.
export function limitImages(content, max) {
  if (typeof content === "string") return content;
  let count = 0;
  return content.filter((b) => b.type !== "image" || count++ < max);
}
