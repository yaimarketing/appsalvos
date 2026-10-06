import * as claude from "./claude.js";
import * as groq from "./groq.js";
import * as gemini from "./gemini.js";
import * as ollama from "./ollama.js";
import { ProviderError } from "./common.js";

export const providers = { claude, groq, gemini, ollama };
export { ProviderError };

export function getProvider(id) {
  const p = providers[id];
  if (!p || p.info.enabled === false) throw new ProviderError(`Motor de IA desconhecido: ${id}`, 400);
  return p;
}

// Chave da sessão (colada pela pessoa) ou, na falta dela, a do servidor.
export function keyFor(session, id) {
  const p = getProvider(id);
  if (!p.info.needsKey) return null;
  return session.keys?.[id] || process.env[p.info.envKey] || null;
}

export function requireKey(session, id) {
  const key = keyFor(session, id);
  if (getProvider(id).info.needsKey && !key) {
    throw new ProviderError(`Conecte sua chave ${getProvider(id).info.of} para continuar.`, 401);
  }
  return key;
}

export function providersInfo(session) {
  return Object.fromEntries(
    Object.values(providers)
      .filter((p) => p.info.enabled !== false)
      .map((p) => [
        p.info.id,
        {
          label: p.info.label,
          paid: p.info.paid,
          needsKey: p.info.needsKey,
          keyUrl: p.info.keyUrl || null,
          connected: Boolean(session.keys?.[p.info.id]),
          serverKey: Boolean(p.info.envKey && process.env[p.info.envKey]),
        },
      ]),
  );
}

export async function listModels(session, id) {
  // O Claude tem modelo fixo e o Ollama não usa chave: só Groq e Gemini precisam dela para listar.
  if (id === "claude" || id === "ollama") return getProvider(id).listModels();
  return getProvider(id).listModels(requireKey(session, id));
}

export async function connectKey(session, id, rawKey) {
  const p = getProvider(id);
  const apiKey = String(rawKey || "").trim();
  if (!p.info.needsKey) throw new ProviderError(`${p.info.label} não usa chave.`, 400);
  if (!p.info.keyPattern.test(apiKey)) throw new ProviderError(`Essa não parece uma chave ${p.info.of}.`, 400);
  await p.validateKey(apiKey);
  session.keys = { ...session.keys, [id]: apiKey };
}

export async function stream({ session, provider, model, system, content, onText, signal }) {
  const p = getProvider(provider);
  const apiKey = requireKey(session, provider);
  let chosen = model;
  if (!chosen) {
    const models = await p.listModels(apiKey);
    if (!models.length) throw new ProviderError(`Nenhum modelo disponível ${p.info.of.replace(/^d/, "n")}.`, 404);
    chosen = models[0].id;
  }
  if (!/^[\w.:\/-]+$/.test(chosen)) throw new ProviderError("Modelo inválido.", 400);
  await p.stream({ apiKey, model: chosen, system, content, onText, signal });
  return chosen;
}
