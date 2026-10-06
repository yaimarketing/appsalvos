import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  InstagramError,
  normalizeSessionId,
  listCollections,
  findCollection,
  fetchCollectionPosts,
  downloadImage,
} from "./src/instagram.js";
import { Anthropic, MODEL, analyzeCollection, generateContent } from "./src/analyzer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(here, "public")));
app.use("/vendor/marked", express.static(path.join(here, "node_modules/marked/lib")));

const clamp = (n, min, max, fallback) => {
  const v = Number.parseInt(n, 10);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};

function errorMessage(err) {
  if (err instanceof InstagramError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "ANTHROPIC_API_KEY inválida ou ausente no servidor.";
  if (err instanceof Anthropic.RateLimitError) return "Limite da API do Claude atingido. Tente novamente em instantes.";
  if (err instanceof Anthropic.BadRequestError) return `Requisição rejeitada pela API do Claude: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Erro da API do Claude (${err.status ?? "rede"}): ${err.message}`;
  return err?.message || "Erro inesperado.";
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
      return { id: `manual-${i}`, url, author: null, type, caption, likes: null, comments: null, views: null, videoDuration: null, slides: null, takenAt: null, images: [] };
    });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: MODEL, hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY) });
});

app.post("/api/collections", async (req, res) => {
  try {
    const sessionId = normalizeSessionId(req.body?.sessionId);
    res.json({ collections: await listCollections(sessionId) });
  } catch (err) {
    res.status(err.status || 500).json({ error: errorMessage(err) });
  }
});

app.post("/api/analyze", async (req, res) => {
  const out = ndjson(res);
  try {
    const body = req.body || {};
    const maxPosts = clamp(body.maxPosts, 1, 150, 40);
    const maxImages = clamp(body.maxImages, 0, 90, 40);
    let posts;

    if (body.source === "manual") {
      posts = parseManualPosts(body.manualText).slice(0, maxPosts);
      if (!posts.length) throw new InstagramError("Cole ao menos um post (separe os posts com uma linha ---).", 400);
    } else {
      const sessionId = normalizeSessionId(body.sessionId);
      out.send({ type: "progress", message: "Procurando a coleção no Instagram…" });
      const collection = await findCollection(sessionId, body.collection);
      out.send({ type: "progress", message: `Coleção "${collection.name}" encontrada. Lendo os posts…` });
      posts = await fetchCollectionPosts(sessionId, collection.id, {
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
      const results = await Promise.all(queue.map((q) => downloadImage(q.url)));
      results.forEach((img, i) => {
        if (!img) return;
        const list = imagesByPost.get(queue[i].postId) || [];
        list.push(img);
        imagesByPost.set(queue[i].postId, list);
      });
    }

    out.send({
      type: "posts",
      posts: posts.map(({ images, ...p }) => ({ ...p, thumbnail: images[0] || null })),
    });
    out.send({ type: "progress", message: `Analisando ${posts.length} posts com o Claude…` });

    let analysis = "";
    await analyzeCollection({
      posts,
      imagesByPost,
      signal: out.signal,
      onText: (t) => {
        analysis += t;
        out.send({ type: "delta", text: t });
      },
      onReset: () => {
        analysis = "";
        out.send({ type: "reset" });
      },
    });
    out.send({ type: "done", analysis });
  } catch (err) {
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
    const posts = Array.isArray(body.posts) ? body.posts.map((p) => ({ type: String(p.type || "post"), caption: String(p.caption || "") })) : [];
    let text = "";
    await generateContent({
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
      onReset: () => {
        text = "";
        out.send({ type: "reset" });
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
  console.log(`AppSalvos rodando em http://localhost:${port} (modelo: ${MODEL})`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Aviso: ANTHROPIC_API_KEY não definida — defina no arquivo .env.");
  }
});
