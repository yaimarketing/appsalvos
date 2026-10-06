// O link do conector carrega os cookies da conta do Instagram criptografados
// (AES-256-GCM). Assim o servidor não precisa guardar nada: funciona mesmo
// depois de reiniciar (como acontece no plano grátis do Render).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_SECRET_FILE = path.join(here, "..", ".appsecret");

// APP_SECRET vem do ambiente (o Render gera um automaticamente). Rodando no
// computador, criamos um segredo local para os links continuarem valendo.
function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  try {
    return fs.readFileSync(LOCAL_SECRET_FILE, "utf8").trim();
  } catch {
    const secret = crypto.randomBytes(32).toString("base64url");
    try {
      fs.writeFileSync(LOCAL_SECRET_FILE, secret, { mode: 0o600 });
    } catch {
      console.warn("Sem APP_SECRET: os links do conector deixam de valer quando o servidor reiniciar.");
    }
    return secret;
  }
}

const KEY = crypto.createHash("sha256").update(loadSecret()).digest();

export function createToken(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify({ v: 1, ...data }), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function readToken(token) {
  try {
    const raw = Buffer.from(String(token), "base64url");
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const data = JSON.parse(json);
    return data.v === 1 ? data : null;
  } catch {
    return null;
  }
}
