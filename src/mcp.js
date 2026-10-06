// Conector MCP: as ferramentas que o Claude ou o ChatGPT da pessoa usam para
// ler a lista de salvos. A análise e a criação dos conteúdos acontecem na IA
// dela, com a assinatura que ela já tem.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as instagram from "./instagram.js";
import { transcribeVideo } from "./transcriber.js";
import { SERVER_INSTRUCTIONS, FORMAT_GUIDES, analysisPrompt } from "./prompts.js";

const text = (t) => ({ type: "text", text: t });
const fail = (message) => ({ content: [text(`Erro: ${message}`)], isError: true });

function postSummary(post, index) {
  const lines = [`### Post #${index + 1} — ${post.type}${post.author ? ` de @${post.author}` : ""}`];
  const meta = [];
  if (post.slides) meta.push(`${post.slides} slides`);
  if (post.videoDuration) meta.push(`${post.videoDuration}s`);
  if (post.likes != null) meta.push(`${post.likes} curtidas`);
  if (post.comments != null) meta.push(`${post.comments} comentários`);
  if (post.views != null) meta.push(`${post.views} visualizações`);
  if (post.takenAt) meta.push(`publicado em ${post.takenAt}`);
  if (meta.length) lines.push(meta.join(" · "));
  if (post.url) lines.push(`Link: ${post.url}`);
  if (post.videoUrl) lines.push("Tem fala/áudio: use transcrever_reel com este link para ler o que é dito.");
  lines.push("", post.caption ? `Legenda:\n${post.caption}` : "(sem legenda)");
  return lines.join("\n");
}

async function withInstagram(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof instagram.InstagramError && err.status === 401) {
      return fail("a sessão do Instagram expirou. Abra o site do AppSalvos, entre de novo e atualize o link do conector.");
    }
    return fail(err.message || "erro inesperado");
  }
}

export function createMcpServer({ auth, username }) {
  const server = new McpServer(
    { name: "appsalvos", title: "AppSalvos", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "listar_colecoes",
    {
      title: "Listar listas de salvos",
      description: "Lista as coleções (listas de posts salvos) da conta do Instagram conectada, com o número de posts.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      withInstagram(async () => {
        const collections = await instagram.listCollections(auth);
        const lines = collections.map((c) => `- ${c.name}${c.count != null ? ` (${c.count} posts)` : ""}`);
        return { content: [text(`Conta: @${username || "conectada"}\nListas de salvos:\n${lines.join("\n")}`)] };
      }),
  );

  server.registerTool(
    "buscar_posts",
    {
      title: "Buscar posts de uma lista de salvos",
      description:
        "Traz os posts de uma lista de salvos: tipo, autor, métricas, link, legenda e imagens de capa para análise visual. " +
        "Use o nome exato da lista (veja listar_colecoes) ou 'Todos os salvos'.",
      inputSchema: {
        colecao: z.string().describe("Nome da lista de salvos, ex.: 'Referências carrossel'"),
        max_posts: z.number().int().min(1).max(60).optional().describe("Quantidade de posts (padrão 20, máx. 60)"),
        max_imagens: z.number().int().min(0).max(15).optional().describe("Imagens de capa para análise visual (padrão 6, máx. 15)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ colecao, max_posts = 20, max_imagens = 6 }) =>
      withInstagram(async () => {
        const collection = await instagram.findCollection(auth, colecao);
        const posts = await instagram.fetchCollectionPosts(auth, collection.id, { limit: max_posts });
        if (!posts.length) return { content: [text(`A lista "${collection.name}" está vazia.`)] };

        const content = [
          text(`Lista "${collection.name}" — ${posts.length} posts.\n\n${posts.map(postSummary).join("\n\n")}`),
        ];
        const withImage = posts.map((p, i) => ({ i, url: p.images[0] })).filter((x) => x.url).slice(0, max_imagens);
        const images = await Promise.all(withImage.map((x) => instagram.downloadImage(x.url)));
        images.forEach((img, k) => {
          if (!img) return;
          content.push(text(`Capa do post #${withImage[k].i + 1}:`));
          content.push({ type: "image", data: img.data, mimeType: img.mediaType });
        });
        return { content };
      }),
  );

  server.registerTool(
    "transcrever_reel",
    {
      title: "Transcrever as falas de um reel",
      description:
        "Transcreve o que é falado em um reel ou vídeo do Instagram (Whisper rodando no servidor do AppSalvos). " +
        "Recebe o link do post. Um reel por chamada; pode levar de alguns segundos a um minuto.",
      inputSchema: { link: z.string().describe("Link do reel, ex.: https://www.instagram.com/reel/XXXX/") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ link }) =>
      withInstagram(async () => {
        const post = await instagram.fetchPostByUrl(auth, link);
        if (!post.videoUrl) return { content: [text("Esse post não é um vídeo/reel, não há fala para transcrever.")] };
        const transcript = await transcribeVideo(post.videoUrl);
        return {
          content: [text(transcript ? `Fala do reel (${link}):\n${transcript}` : "Não foi detectada fala nesse reel (pode ser só música).")],
        };
      }),
  );

  server.registerPrompt(
    "analisar_colecao",
    {
      title: "Analisar lista de salvos e criar conteúdos",
      description: "Analisa uma lista de salvos e cria conteúdos originais no mesmo estilo.",
      argsSchema: {
        colecao: z.string().describe("Nome da lista de salvos"),
        formato: z.string().optional().describe(`Formato: ${Object.keys(FORMAT_GUIDES).join(", ")}`),
        quantidade: z.string().optional().describe("Quantos conteúdos criar (padrão 3)"),
        sobre: z.string().optional().describe("Nicho, marca, público, tom e objetivo de quem vai publicar"),
      },
    },
    (args) => ({ messages: [{ role: "user", content: text(analysisPrompt(args)) }] }),
  );

  return server;
}
