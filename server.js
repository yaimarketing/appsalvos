import express from "express";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as instagram from "./src/instagram.js";
import { InstagramError } from "./src/instagram.js";
import { Anthropic, MODEL, clientFor, analyzeCollection, generateContent, validateApiKey } from "./src/analyzer.js";
import { transcribeVideo, WHISPER_MODEL } from "./src/transcriber.js";
import { sessionMiddleware } from "./src/session.js";
import { OllamaError, OLLAMA_URL, listModels as listOllamaModels, ensureModel as ensureOllamaModel } from "./src/ollama.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(here, "public")));
app.use("/vendor/marked", express.static(path.join(here, "node_modules/marked/lib")));
app.use("/api", sessionMiddleware);

const clamp = (n, min, max, fallback) => {
  const v = Number.parseInt(n, 10);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};

function errorMessage(err) {
  if (err instanceof InstagramError || err instanceof OllamaError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "Chave da API do Claude inválida. Conecte sua conta novamente.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Essa chave da API não tem permissão para usar o modelo.";
  if (err instanceof Anthropic.RateLimitError) return "Limite da API do Claude atingido. Tente novamente em instantes.";
  if (err instanceof Anthropic.BadRequestError) return `Requisição rejeitada pela API do Claude: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Erro da API do Claude (${err.status ?? "rede"}): ${err.message}`;
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
  return {
    instagram: session.instagram ? { connected: true, username: session.instagram.username } : { connected: false },
    claude: {
      connected: Boolean(session.claudeApiKey),
      serverKey: Boolean(process.env.ANTHROPIC_API_KEY),
    },
    model: MODEL,
  };
}

// Define qual IA atende a requisição e confere se ela está pronta para uso.
async function resolveAI(req, body) {
  if (body.provider === "ollama") {
    const model = String(body.ollamaModel || "");
    await ensureOllamaModel(model);
    return { provider: "ollama", model };
  }
  clientFor(req.session.claudeApiKey); // falha cedo se não houver conta Claude conectada
  return { provider: "claude", apiKey: req.session.claudeApiKey };
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

app.post("/api/claude/login", async (req, res) => {
  try {
    const apiKey = String(req.body?.apiKey || "").trim();
    if (!/^sk-ant-[\w-]+$/.test(apiKey)) {
      return res.status(400).json({ error: "Cole uma chave da API válida (começa com sk-ant-)." });
    }
    await validateApiKey(apiKey);
    req.session.claudeApiKey = apiKey;
    res.json(sessionInfo(req.session));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/claude/logout", (req, res) => {
  req.session.claudeApiKey = null;
  res.json(sessionInfo(req.session));
});

app.get("/api/ollama/models", async (_req, res) => {
  try {
    res.json({ url: OLLAMA_URL, models: await listOllamaModels() });
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
    const ai = await resolveAI(req, body);
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

    // Transcreve as falas dos vídeos localmente (Whisper), um por vez.
    const videos = posts.filter((p) => p.videoUrl).slice(0, maxTranscripts);
    for (const [i, post] of videos.entries()) {
      if (out.signal.aborted) return;
      out.send({
        type: "progress",
        message: `Transcrevendo falas do reel ${i + 1} de ${videos.length}${i === 0 ? ` (na primeira vez o modelo ${WHISPER_MODEL} é baixado; pode demorar)` : ""}…`,
      });
      try {
        post.transcript = await transcribeVideo(post.videoUrl);
      } catch (err) {
        out.send({ type: "warning", message: `Não foi possível transcrever o reel ${i + 1}: ${err.message}` });
        if (/Whisper/.test(err.message)) break;
      }
    }

    out.send({
      type: "posts",
      posts: posts.map(({ images, videoUrl, ...p }) => ({ ...p, thumbnail: images[0] || null })),
    });
    const aiName = ai.provider === "ollama" ? `o Ollama (${ai.model})` : "o Claude";
    out.send({ type: "progress", message: `Analisando ${posts.length} posts com ${aiName}…` });

    let analysis = "";
    await analyzeCollection({
      ai,
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
    const ai = await resolveAI(req, body);
    let text = "";
    await generateContent({
      ai,
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
  console.log(`AppSalvos rodando em http://localhost:${port} (Claude: ${MODEL}, Ollama: ${OLLAMA_URL})`);
  // Endereços na rede local, para abrir pelo celular conectado ao mesmo Wi-Fi.
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) console.log(`No celular (mesmo Wi-Fi): http://${a.address}:${port}`);
    }
  }
});
