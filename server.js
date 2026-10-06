import express from "express";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as instagram from "./src/instagram.js";
import { InstagramError } from "./src/instagram.js";
import { sessionMiddleware } from "./src/session.js";
import { createToken, readToken } from "./src/token.js";
import { createMcpServer } from "./src/mcp.js";

// Senha de acesso ao site (onde se conecta o Instagram). Obrigatória online;
// sem ela qualquer pessoa com o endereço usaria o servidor.
const APP_PASSWORD = process.env.APP_PASSWORD || "";
// Render define RENDER=true; Hugging Face define SPACE_ID.
const IS_ONLINE = Boolean(process.env.RENDER || process.env.SPACE_ID || process.env.REQUIRE_APP_PASSWORD);
const PASSWORD_MISSING_ONLINE = IS_ONLINE && !APP_PASSWORD;

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Atrás do proxy HTTPS do provedor de hospedagem: confia no X-Forwarded-Proto
// para montar o link https do conector e marcar o cookie como Secure.
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "public")));

// ---------- Conector MCP (usado pelo Claude / ChatGPT) ----------

// O token no caminho é o próprio link pessoal: carrega os cookies do Instagram criptografados.
app.post("/mcp/:token", async (req, res) => {
  const data = readToken(req.params.token);
  if (!data?.auth) {
    return res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Link do conector inválido. Gere um novo no site do AppSalvos." },
      id: null,
    });
  }
  const server = createMcpServer({ auth: data.auth, username: data.username });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Erro no conector:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erro interno" }, id: null });
    }
  }
});

// Servidor sem estado: não há stream GET nem encerramento de sessão.
app.all("/mcp/:token", (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST." }, id: null });
});

// ---------- Site: senha e conexão do Instagram ----------

app.use("/api", sessionMiddleware);

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.use("/api", (req, res, next) => {
  if (!PASSWORD_MISSING_ONLINE || req.path === "/session") return next();
  res.status(503).json({ error: "Configure a variável APP_PASSWORD no serviço de hospedagem para usar o app." });
});

app.post("/api/app-login", async (req, res) => {
  if (!APP_PASSWORD || safeEqual(req.body?.password || "", APP_PASSWORD)) {
    req.session.appAuthed = true;
    return res.json(sessionInfo(req));
  }
  await new Promise((r) => setTimeout(r, 1000)); // freia tentativas de adivinhar a senha
  res.status(401).json({ error: "Senha incorreta." });
});

// Tudo abaixo exige a senha do app (se configurada), exceto consultar a sessão.
app.use("/api", (req, res, next) => {
  if (!APP_PASSWORD || req.session.appAuthed || req.path === "/session") return next();
  res.status(401).json({ error: "Digite a senha do app.", appLocked: true });
});

function sendError(res, err) {
  if (!(err instanceof InstagramError)) console.error(err);
  res.status(err.status && err.status < 600 ? err.status : 500).json({ error: err.message || "Erro inesperado." });
}

function connectorUrl(req, token) {
  return `${req.protocol}://${req.get("host")}/mcp/${token}`;
}

function sessionInfo(req) {
  const s = req.session;
  return {
    app: {
      passwordRequired: Boolean(APP_PASSWORD),
      locked: Boolean(APP_PASSWORD) && !s.appAuthed,
      passwordMissing: PASSWORD_MISSING_ONLINE,
    },
    instagram: s.instagram
      ? { connected: true, username: s.instagram.username, connectorUrl: connectorUrl(req, s.instagram.token) }
      : { connected: false },
  };
}

function connect(req, auth, username) {
  req.session.instagram = { auth, username, token: createToken({ auth, username }) };
  req.session.pendingInstagram = null;
}

app.get("/api/session", (req, res) => res.json(sessionInfo(req)));

app.post("/api/instagram/login", async (req, res) => {
  try {
    const result = await instagram.login(req.body?.username, req.body?.password);
    if (result.twoFactor) {
      req.session.pendingInstagram = { ...result.twoFactor, auth: result.auth };
      return res.json({ twoFactorRequired: true, method: result.twoFactor.method, phoneHint: result.twoFactor.phoneHint });
    }
    connect(req, result.auth, result.username);
    res.json(sessionInfo(req));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/instagram/2fa", async (req, res) => {
  try {
    const pending = req.session.pendingInstagram;
    if (!pending) throw new InstagramError("Faça o login novamente.", 400);
    const result = await instagram.verifyTwoFactor(pending, req.body?.code);
    if (result.twoFactor) throw new InstagramError("Código inválido. Tente de novo.", 401);
    connect(req, result.auth, result.username);
    res.json(sessionInfo(req));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/instagram/session", async (req, res) => {
  try {
    const auth = instagram.authFromSessionId(req.body?.sessionId);
    const username = await instagram.currentUsername(auth);
    connect(req, auth, username);
    res.json(sessionInfo(req));
  } catch (err) {
    sendError(res, err);
  }
});

// Sair encerra a sessão no Instagram: o link do conector deixa de funcionar.
app.post("/api/instagram/logout", async (req, res) => {
  const current = req.session.instagram;
  req.session.instagram = null;
  req.session.pendingInstagram = null;
  if (current) await instagram.logout(current.auth);
  res.json(sessionInfo(req));
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`AppSalvos rodando em http://localhost:${port}`);
  if (PASSWORD_MISSING_ONLINE) console.log("APP_PASSWORD não definida: o site fica bloqueado até você configurar a senha.");
  else if (!APP_PASSWORD) console.log("Sem APP_PASSWORD: o site abre sem senha (ok para uso local; defina antes de colocar online).");
  if (IS_ONLINE) return;
  console.log("Atenção: Claude e ChatGPT só acessam o conector por um endereço público (https). Para uso real, publique o app (ex.: Render).");
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) console.log(`No celular (mesmo Wi-Fi): http://${a.address}:${port}`);
    }
  }
});
