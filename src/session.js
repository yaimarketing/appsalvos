import crypto from "node:crypto";

// Sessões em memória: guardam as credenciais do Instagram e a chave da API
// do Claude de cada navegador. Nada é gravado em disco; reiniciar o servidor
// desconecta todo mundo.
const COOKIE = "appsalvos_sid";
const TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionMiddleware(req, res, next) {
  const now = Date.now();
  let id = readCookie(req, COOKIE);
  let session = id && sessions.get(id);
  if (!session || session.expiresAt < now) {
    if (id) sessions.delete(id);
    id = crypto.randomBytes(24).toString("base64url");
    session = { instagram: null, pendingInstagram: null, claudeApiKey: null };
    sessions.set(id, session);
  }
  session.expiresAt = now + TTL_MS;
  const secure = req.secure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}${secure}`,
  );
  req.session = session;
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
}, 60 * 60 * 1000).unref();
