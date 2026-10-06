// Textos que orientam a IA da pessoa (Claude ou ChatGPT) a analisar a coleção
// e criar conteúdos. Usados nas instruções do conector e no prompt pronto.

export const SERVER_INSTRUCTIONS = `AppSalvos dá acesso às listas de posts salvos (coleções) de uma conta do Instagram.
Fluxo recomendado:
1. listar_colecoes para ver as listas disponíveis.
2. buscar_posts com o nome da lista: traz legendas, métricas, links e imagens de capa.
3. transcrever_reel para cada reel cujas falas importem (um por chamada; pode levar alguns segundos).
4. Analise a coleção (temas, formatos, ganchos, roteiro e falas, tom, identidade visual, CTAs, por que os posts são salvos, fórmulas replicáveis).
5. Crie conteúdos ORIGINAIS no mesmo estilo, sem copiar frases ou ideias específicas dos criadores.
Responda em português do Brasil, a menos que a pessoa peça outro idioma.`;

export const ANALYSIS_SECTIONS = `## Visão geral
O que essa coleção tem em comum em 3–5 frases. Qual parece ser a intenção de quem salvou.
## Temas e assuntos recorrentes
## Formatos e estruturas
Distribuição entre reels, carrosséis e imagens; como os conteúdos são estruturados (lista, antes/depois, storytelling, tutorial…).
## Roteiro e falas dos reels
Com base nas transcrições: como as falas abrem, ritmo, estrutura do roteiro, expressões recorrentes.
## Ganchos
Padrões de abertura (primeira frase/primeiro slide) que prendem atenção, com exemplos.
## Tom de voz e linguagem
## Identidade visual
Paleta, tipografia, enquadramento, uso de texto na imagem, estética.
## Chamadas para ação (CTAs)
## Por que esses posts são salvos
## Sinais de desempenho
O que os posts com mais engajamento têm em comum (se houver métricas).
## Fórmulas replicáveis
5 a 8 fórmulas concretas, cada uma com nome curto, estrutura e o post de origem.`;

export const FORMAT_GUIDES = {
  misto: "escolha para cada ideia o formato (reel, carrossel ou post estático) que a análise indica funcionar melhor",
  carrossel: "carrossel com copy card a card (Card 1, Card 2…), gancho no Card 1 e CTA no último",
  reel: "roteiro de reel com gancho dos 3 primeiros segundos, falas/cenas numeradas, texto na tela, duração e áudio sugeridos",
  estatico: "post estático com texto da arte (título e apoio) e descrição da composição visual",
  legenda: "apenas legendas completas, com gancho na primeira linha e CTA no final",
};

export function analysisPrompt({ colecao, formato = "misto", quantidade = "3", sobre }) {
  const guide = FORMAT_GUIDES[formato] || FORMAT_GUIDES.misto;
  return `Use o conector AppSalvos para analisar a minha lista de salvos "${colecao}" do Instagram.

1. Busque os posts da lista com buscar_posts.
2. Transcreva as falas dos reels mais relevantes com transcrever_reel (até 5).
3. Escreva a análise com estas seções:
${ANALYSIS_SECTIONS}

4. Depois crie ${quantidade} conteúdo(s) original(is) no formato: ${guide}.
Para cada conteúdo: título interno e fórmula usada (com os posts de referência, ex.: [#2]), formato e objetivo,
gancho, conteúdo completo, direção visual e legenda pronta com CTA e até 5 hashtags.
Nunca copie frases ou ideias específicas dos criadores originais.${sobre ? `\n\nSobre quem vai publicar: ${sobre}` : ""}`;
}
