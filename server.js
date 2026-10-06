import express from "express";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as instagram from "./src/instagram.js";
import { InstagramError } from "./src/instagram.js";
import crypto from "node:crypto";
import { analyzeCollection, generateContent } from "./src/analyzer.js";
import { transcribeVideo, WHISPER_MODEL } from "./src/transcriber.js";
import { sessionMiddleware } from "./src/session.js";
import * as ai from "./src/providers/index.js";
import { ProviderError } from "./src/providers/index.js";
import { MODEL as CLAUDE_MODEL } from "./src/providers/claude.js";
import { OLLAMA_URL } from "./src/providers/ollama.js";

// Senha de acesso ao app. Obrigatória quando o app está online (ex.: Hugging Face);
// sem ela qualquer pessoa com o link usaria o app (e as chaves do servidor).
const APP_PASSWORD = process.env.APP_PASSWORD || "";
// No Hugging Face (variável SPACE_ID) o app fica público: sem senha, não libera nada.
const PASSWORD_MISSING_ONLINE = Boolean(process.env.SPACE_ID) && !APP_PASSWORD;

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Atrás do proxy HTTPS do provedor de hospedagem: confia no X-Forwarded-Proto
// para marcar o cookie de sessão como Secure.
app.set("trust proxy", 1);
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(here, "public")));
app.use("/vendor/marked", express.static(path.join(here, "node_modules/marked/lib")));
app.use("/api", sessionMiddleware);

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.use("/api", (req, res, next) => {
  if (!PASSWORD_MISSING_ONLINE || req.path === "/session") return next();
  res.status(503).json({ error: "Configure o secret APP_PASSWORD no Space do Hugging Face para usar o app." });
});

app.post("/api/app-login", async (req, res) => {
  if (!APP_PASSWORD || safeEqual(req.body?.password || "", APP_PASSWORD)) {
    req.session.appAuthed = true;
    return res.json(sessionInfo(req.session));
  }
  await new Promise((r) => setTimeout(r, 1000)); // freia tentativas de adivinhar a senha
  res.status(401).json({ error: "Senha incorreta." });
});

// Tudo abaixo exige a senha do app (se configurada), exceto consultar a sessão.
app.use("/api", (req, res, next) => {
  if (!APP_PASSWORD || req.session.appAuthed || req.path === "/session") return next();
  res.status(401).json({ error: "Digite a senha do app.", appLocked: true });
});

const clamp = (n, min, max, fallback) => {
  const v = Number.parseInt(n, 10);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};

function errorMessage(err) {
  if (err instanceof InstagramError || err instanceof ProviderError) return err.message;
  console.error(err);
  return err?.message || "Erro inesperado.";
}

function sendError(res, err) {
  res.status(err.status && err.status < 600 ? err.status : 500).json({ error: errorMessage(err) });
}

function requireInstagram(req) {
  if (!req.session.instagram) throw new InstagramError("Entre na sua conta do Instagram primeiro.", 401);
  return req.session.instagram.auth;
}

// Se o Instagram disser que a sessão expirou, desconecta para a tela pedir login de novo.
function forgetExpiredInstagram(req, err) {
  if (err instanceof InstagramError && err.status === 401) req.session.instagram = null;
}

function sessionInfo(session) {
  const locked = Boolean(APP_PASSWORD) && !session.appAuthed;
  return {
    app: { passwordRequired: Boolean(APP_PASSWORD), locked, passwordMissing: PASSWORD_MISSING_ONLINE },
    instagram: session.instagram ? { connected: true, username: session.instagram.username } : { connected: false },
    providers: ai.providersInfo(session),
    transcription: { groqAvailable: Boolean(ai.keyFor(session, "groq")) },
  };
}

// Define qual IA atende a requisição e confere se ela está pronta para uso.
function resolveAI(req, body) {
  const provider = String(body.provider || "claude");
  ai.requireKey(req.session, provider); // falha cedo se faltar a chave
  return { session: req.session, provider, model: body.model ? String(body.model) : "" };
}

// Respostas em NDJSON: um objeto JSON por linha, lido pelo navegador em streaming.
function ndjson(res) {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  return {
    signal: controller.signal,
    send: (obj) => {
      if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n");
    },
    end: () => res.end(),
  };
}

// Modo manual: blocos separados por uma linha "---"; URLs viram link do post,
// o restante vira a legenda/descrição.
function parseManualPosts(text) {
  return String(text || "")
    .split(/^\s*-{3,}\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block, i) => {
      const url = block.match(/https?:\/\/\S+/)?.[0] || null;
      const caption = block.replace(/https?:\/\/\S+/g, "").trim();
      const type = /reel/i.test(url || "") ? "reel" : "post";
      return { id: `manual-${i}`, url, author: null, type, caption, likes: null, comments: null, views: null, videoDuration: null, slides: null, takenAt: null, images: [], videoUrl: null, transcript: null };
    });
}

// ---------- Sessão e contas ----------

app.get("/api/session", (req, res) => res.json(sessionInfo(req.session)));

app.post("/api/instagram/login", async (req, res) => {
  try {
    const result = await instagram.login(req.body?.username, req.body?.password);
    if (result.twoFactor) {
      req.session.pendingInstagram = { ...result.twoFactor, auth: result.auth };
      return res.json({ twoFactorRequired: true, method: result.twoFactor.method, phoneHint: result.twoFactor.phoneHint });
    }
    req.session.instagram = { auth: result.auth, username: result.username };
    req.session.pendingInstagram = null;
    res.json(sessionInfo(req.session));
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
    req.session.instagram = { auth: result.auth, username: result.username };
    req.session.pendingInstagram = null;
    res.json(sessionInfo(req.session));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/instagram/session", async (req, res) => {
  try {
    const auth = instagram.authFromSessionId(req.body?.sessionId);
    const username = await instagram.currentUsername(auth);
    req.session.instagram = { auth, username };
    res.json(sessionInfo(req.session));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/instagram/logout", async (req, res) => {
  const current = req.session.instagram;
  req.session.instagram = null;
  req.session.pendingInstagram = null;
  if (current) await instagram.logout(current.auth);
  res.json(sessionInfo(req.session));
});

app.post("/api/keys/:provider", async (req, res) => {
  try {
    await ai.connectKey(req.session, req.params.provider, req.body?.apiKey);
    res.json(sessionInfo(req.session));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/keys/:provider/logout", (req, res) => {
  if (req.session.keys) delete req.session.keys[req.params.provider];
  res.json(sessionInfo(req.session));
});

app.get("/api/models/:provider", async (req, res) => {
  try {
    res.json({ models: await ai.listModels(req.session, req.params.provider) });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Coleções, análise e geração ----------

app.get("/api/collections", async (req, res) => {
  try {
    res.json({ collections: await instagram.listCollections(requireInstagram(req)) });
  } catch (err) {
    forgetExpiredInstagram(req, err);
    sendError(res, err);
  }
});

app.post("/api/analyze", async (req, res) => {
  const out = ndjson(res);
  try {
    const body = req.body || {};
    const maxPosts = clamp(body.maxPosts, 1, 150, 40);
    const maxImages = clamp(body.maxImages, 0, 90, 40);
    const maxTranscripts = body.transcribe ? clamp(body.maxTranscripts, 0, 50, 15) : 0;
    const aiChoice = resolveAI(req, body);
    const engine = body.transcriber === "groq" ? "groq" : "local";
    const groqKey = engine === "groq" ? ai.requireKey(req.session, "groq") : null;
    let posts;

    if (body.source === "manual") {
      posts = parseManualPosts(body.manualText).slice(0, maxPosts);
      if (!posts.length) throw new InstagramError("Cole ao menos um post (separe os posts com uma linha ---).", 400);
    } else {
      const auth = requireInstagram(req);
      out.send({ type: "progress", message: "Procurando a coleção no Instagram…" });
      const collection = await instagram.findCollection(auth, body.collection);
      out.send({ type: "progress", message: `Coleção "${collection.name}" encontrada. Lendo os posts…` });
      posts = await instagram.fetchCollectionPosts(auth, collection.id, {
        limit: maxPosts,
        onProgress: (n) => out.send({ type: "progress", message: `${n} posts lidos…` }),
      });
      if (!posts.length) throw new InstagramError("Essa coleção está vazia.", 404);
    }

    // Distribui o orçamento de imagens: primeiro a capa de cada post, depois slides extras.
    const imagesByPost = new Map();
    const queue = [];
    for (let round = 0; queue.length < maxImages; round++) {
      let added = false;
      for (const p of posts) {
        if (p.images[round] && queue.length < maxImages) {
          queue.push({ postId: p.id, url: p.images[round] });
          added = true;
        }
      }
      if (!added) break;
    }
    if (queue.length) {
      out.send({ type: "progress", message: `Baixando ${queue.length} imagens para análise visual…` });
      const results = await Promise.all(queue.map((q) => instagram.downloadImage(q.url)));
      results.forEach((img, i) => {
        if (!img) return;
        const list = imagesByPost.get(queue[i].postId) || [];
        list.push(img);
        imagesByPost.set(queue[i].postId, list);
      });
    }

    // Transcreve as falas dos vídeos (Whisper local ou na Groq), um por vez.
    const videos = posts.filter((p) => p.videoUrl).slice(0, maxTranscripts);
    for (const [i, post] of videos.entries()) {
      if (out.signal.aborted) return;
      out.send({
        type: "progress",
        message: `Transcrevendo falas do reel ${i + 1} de ${videos.length}${i === 0 && engine === "local" ? ` (na primeira vez o modelo ${WHISPER_MODEL} é baixado; pode demorar)` : ""}…`,
      });
      try {
        post.transcript = await transcribeVideo(post.videoUrl, { engine, groqKey });
      } catch (err) {
        out.send({ type: "warning", message: `Não foi possível transcrever o reel ${i + 1}: ${err.message}` });
        if (/Whisper/.test(err.message)) break;
      }
    }

    out.send({
      type: "posts",
      posts: posts.map(({ images, videoUrl, ...p }) => ({ ...p, thumbnail: images[0] || null })),
    });
    const aiName = ai.providers[aiChoice.provider].info.label;
    out.send({ type: "progress", message: `Analisando ${posts.length} posts com ${aiName}${aiChoice.model ? ` (${aiChoice.model})` : ""}…` });

    let analysis = "";
    await analyzeCollection({
      ai: aiChoice,
      posts,
      imagesByPost,
      signal: out.signal,
      onText: (t) => {
        analysis += t;
        out.send({ type: "delta", text: t });
      },
    });
    out.send({ type: "done", analysis });
  } catch (err) {
    forgetExpiredInstagram(req, err);
    if (!out.signal.aborted) out.send({ type: "error", message: errorMessage(err) });
  } finally {
    out.end();
  }
});

app.post("/api/generate", async (req, res) => {
  const out = ndjson(res);
  try {
    const body = req.body || {};
    if (!body.analysis) throw new InstagramError("Faça a análise da coleção antes de gerar conteúdos.", 400);
    const posts = Array.isArray(body.posts)
      ? body.posts.map((p) => ({
          type: String(p.type || "post"),
          caption: String(p.caption || ""),
          transcript: p.transcript ? String(p.transcript) : null,
        }))
      : [];
    const aiChoice = resolveAI(req, body);
    let text = "";
    await generateContent({
      ai: aiChoice,
      analysis: String(body.analysis),
      posts,
      format: body.format,
      quantity: clamp(body.quantity, 1, 10, 3),
      brief: String(body.brief || "").slice(0, 4000),
      signal: out.signal,
      onText: (t) => {
        text += t;
        out.send({ type: "delta", text: t });
      },
    });
    out.send({ type: "done", text });
  } catch (err) {
    if (!out.signal.aborted) out.send({ type: "error", message: errorMessage(err) });
  } finally {
    out.end();
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`AppSalvos rodando em http://localhost:${port} (Claude: ${CLAUDE_MODEL}, Ollama: ${OLLAMA_URL})`);
  if (!APP_PASSWORD) console.log("Sem APP_PASSWORD: o app abre sem senha (ok para uso local; defina antes de colocar online).");
  // Endereços na rede local, para abrir pelo celular conectado ao mesmo Wi-Fi.
  if (process.env.SPACE_ID) return;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) console.log(`No celular (mesmo Wi-Fi): http://${a.address}:${port}`);
    }
  }
});
