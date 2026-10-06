import Anthropic from "@anthropic-ai/sdk";

export const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

const client = new Anthropic();

const ANALYSIS_SYSTEM = `Você é um estrategista sênior de conteúdo para Instagram.
Recebe uma coleção de posts que uma pessoa salvou como referência e descobre, com precisão,
o que faz esses conteúdos funcionarem — para que depois sejam criados conteúdos originais
com a mesma força. Escreva em português do Brasil, em Markdown, com exemplos concretos
tirados dos posts (cite o número do post entre colchetes, ex.: [#3]).`;

const ANALYSIS_TASK = `Analise todos os posts acima e entregue um relatório com estas seções:

## Visão geral
O que essa coleção tem em comum em 3–5 frases. Qual parece ser a intenção de quem salvou.

## Temas e assuntos recorrentes
## Formatos e estruturas
Distribuição entre reels, carrosséis e imagens; como os conteúdos são estruturados (ex.: lista, antes/depois, storytelling, tutorial passo a passo).
## Ganchos
Padrões de abertura (primeira frase/primeiro slide) que prendem atenção, com exemplos.
## Tom de voz e linguagem
## Identidade visual
Paleta, tipografia, enquadramento, uso de texto na imagem, estética (com base nas imagens enviadas).
## Chamadas para ação (CTAs)
## Por que esses posts são salvos
O valor que entregam (utilidade, identificação, inspiração, referência…).
## Sinais de desempenho
Se houver métricas, o que os posts com mais engajamento têm em comum. Se não houver, diga isso em uma linha.
## Fórmulas replicáveis
5 a 8 "fórmulas" concretas e reutilizáveis extraídas da coleção, cada uma com nome curto, estrutura e o post de origem.`;

const GENERATION_SYSTEM = `Você é um copywriter e roteirista sênior de Instagram.
Cria conteúdos ORIGINAIS inspirados nos padrões de uma coleção de referência — nunca copia
frases, ideias específicas ou identidade de outros criadores. Escreva em português do Brasil,
em Markdown, pronto para a pessoa usar.`;

const FORMAT_GUIDES = {
  misto: "Escolha, para cada conteúdo, o formato (reel, carrossel ou post estático) que a análise indica funcionar melhor para aquela ideia.",
  carrossel: "Carrossel: copy card a card (Card 1, Card 2…), com o gancho no Card 1 e CTA no último card.",
  reel: "Reel: roteiro com gancho dos primeiros 3 segundos, falas/cenas numeradas, texto na tela, sugestão de duração e de áudio.",
  estatico: "Post estático: texto da arte (título e apoio) e descrição da composição visual.",
  legenda: "Apenas legendas: legendas completas com gancho na primeira linha e CTA no final.",
};

function postToText(post, index) {
  const lines = [`### Post #${index + 1} — ${post.type}${post.author ? ` de @${post.author}` : ""}`];
  const meta = [];
  if (post.slides) meta.push(`${post.slides} slides`);
  if (post.videoDuration) meta.push(`${post.videoDuration}s`);
  if (post.likes != null) meta.push(`${post.likes} curtidas`);
  if (post.comments != null) meta.push(`${post.comments} comentários`);
  if (post.views != null) meta.push(`${post.views} visualizações`);
  if (post.takenAt) meta.push(`publicado em ${post.takenAt}`);
  if (meta.length) lines.push(meta.join(" · "));
  if (post.url) lines.push(post.url);
  lines.push("", post.caption ? `Legenda:\n${post.caption}` : "(sem legenda)");
  return lines.join("\n");
}

// Monta o conteúdo do usuário intercalando texto e imagens de cada post.
export function buildAnalysisContent(posts, imagesByPost) {
  const content = [
    {
      type: "text",
      text: `Coleção com ${posts.length} posts salvos. Imagens (capas/slides) seguem cada post quando disponíveis.`,
    },
  ];
  posts.forEach((post, i) => {
    content.push({ type: "text", text: postToText(post, i) });
    for (const img of imagesByPost.get(post.id) || []) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      });
    }
  });
  content.push({ type: "text", text: ANALYSIS_TASK });
  return content;
}

export function buildGenerationContent({ analysis, posts, format, quantity, brief }) {
  const captions = posts
    .slice(0, 30)
    .map((p, i) => `#${i + 1} (${p.type}): ${p.caption.slice(0, 400).replace(/\s+/g, " ")}`)
    .join("\n");
  const guide = FORMAT_GUIDES[format] || FORMAT_GUIDES.misto;
  return `# Análise da coleção de referência
${analysis}

# Trechos das legendas originais (apenas referência de estilo — não copie)
${captions || "(nenhuma)"}

# Tarefa
Crie ${quantity} conteúdo(s) novo(s) para Instagram que apliquem os padrões e fórmulas da análise.
Formato: ${guide}
${brief ? `\nContexto de quem vai publicar (nicho, marca, público, tom, objetivo):\n${brief}\n` : ""}
Para cada conteúdo entregue:
1. **Título interno** e **fórmula da análise usada** (com os posts de referência, ex.: [#2], [#7])
2. **Formato** e **objetivo** (alcance, salvamentos, compartilhamentos, comentários ou conversão)
3. **Gancho**
4. **Conteúdo completo** no formato pedido
5. **Direção visual** (como deve parecer, alinhado à identidade visual da coleção)
6. **Legenda** pronta, com CTA e até 5 hashtags

Separe cada conteúdo com uma linha horizontal (---).`;
}

// Faz uma chamada em streaming e repassa os eventos via callbacks.
// Usa fallback automático do servidor caso o modelo recuse a requisição.
export async function streamClaude({ system, content, onText, onReset, signal }) {
  const stream = client.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 32000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high" },
      system,
      messages: [{ role: "user", content }],
    },
    { signal },
  );

  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block.type === "fallback") {
      // Outro modelo assumiu a resposta: o texto parcial anterior deve ser descartado.
      onReset?.();
    } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      onText(event.delta.text);
    }
  }

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new Error("O modelo recusou esta solicitação. Revise o conteúdo da coleção ou as instruções.");
  }
  if (message.stop_reason === "max_tokens") {
    onText("\n\n> ⚠️ Resposta interrompida pelo limite de tamanho. Tente pedir menos conteúdos por vez.");
  }
  return message;
}

export function analyzeCollection({ posts, imagesByPost, onText, onReset, signal }) {
  return streamClaude({
    system: ANALYSIS_SYSTEM,
    content: buildAnalysisContent(posts, imagesByPost),
    onText,
    onReset,
    signal,
  });
}

export function generateContent({ analysis, posts, format, quantity, brief, onText, onReset, signal }) {
  return streamClaude({
    system: GENERATION_SYSTEM,
    content: buildGenerationContent({ analysis, posts, format, quantity, brief }),
    onText,
    onReset,
    signal,
  });
}

export { Anthropic };
