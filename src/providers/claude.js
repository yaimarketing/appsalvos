import Anthropic from "@anthropic-ai/sdk";
import { ProviderError, TRUNCATED_NOTE } from "./common.js";

export const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5";

export const info = {
  id: "claude",
  label: "Claude",
  of: "do Claude",
  paid: true,
  needsKey: true,
  envKey: "ANTHROPIC_API_KEY",
  keyPattern: /^sk-ant-[\w-]+$/,
  keyUrl: "https://console.anthropic.com/settings/keys",
};

function client(apiKey) {
  return new Anthropic({ apiKey });
}

export function mapError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError("Chave do Claude inválida. Conecte novamente.", 401);
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError("Essa chave do Claude não tem permissão para usar o modelo.", 403);
  if (err instanceof Anthropic.RateLimitError) return new ProviderError("Limite da API do Claude atingido. Tente novamente em instantes.", 429);
  if (err instanceof Anthropic.BadRequestError) return new ProviderError(`Requisição rejeitada pelo Claude: ${err.message}`, 400);
  if (err instanceof Anthropic.APIError) return new ProviderError(`Erro da API do Claude (${err.status ?? "rede"}): ${err.message}`, 502);
  return err;
}

export async function validateKey(apiKey) {
  try {
    await client(apiKey).models.retrieve(MODEL);
  } catch (err) {
    throw mapError(err);
  }
}

export async function listModels() {
  return [{ id: MODEL, label: MODEL === "claude-haiku-4-5" ? "Claude Haiku 4.5" : MODEL, vision: true }];
}

export async function stream({ apiKey, system, content, onText, signal }) {
  try {
    const s = client(apiKey).messages.stream(
      { model: MODEL, max_tokens: 32000, system, messages: [{ role: "user", content }] },
      { signal },
    );
    for await (const event of s) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") onText(event.delta.text);
    }
    const message = await s.finalMessage();
    if (message.stop_reason === "refusal") {
      throw new ProviderError("O Claude recusou esta solicitação. Revise o conteúdo da coleção ou as instruções.", 400);
    }
    if (message.stop_reason === "max_tokens") onText(TRUNCATED_NOTE);
  } catch (err) {
    throw mapError(err);
  }
}
