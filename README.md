# AppSalvos

App web que acessa uma conta do Instagram, abre a **lista de salvos (coleção)** que você informar,
analisa o conteúdo de todos os posts dessa lista com o Claude (legendas, métricas e imagens/capas)
e **gera conteúdos novos no mesmo estilo**: carrosséis, roteiros de reel, posts estáticos ou legendas.

## Como funciona

1. **Fonte dos salvos**
   - **Conectar Instagram:** você cola o cookie `sessionid` da sua conta (as instruções estão na própria tela),
     informa o nome da coleção (ou clica em *Listar minhas coleções*) e o app busca os posts pela API
     web do instagram.com.
   - **Colar manualmente:** cole links + legendas/descrições separados por `---` (útil sem login ou para testes).
2. **Análise:** o servidor baixa as capas/slides (até o limite configurado) e envia tudo ao Claude, que
   devolve um relatório com temas, formatos, ganchos, tom de voz, identidade visual, CTAs, por que os posts
   são salvos e *fórmulas replicáveis*.
3. **Geração:** escolha formato, quantidade e descreva quem vai publicar (nicho, público, tom). O Claude
   cria conteúdos originais aplicando as fórmulas, com gancho, conteúdo completo, direção visual e legenda.

A análise e os conteúdos aparecem em tempo real e podem ser copiados ou baixados em `.md`.

## Rodando

Requer Node.js 22.9+ e uma chave da [API da Anthropic](https://console.anthropic.com/).

```bash
npm install
cp .env.example .env   # edite e coloque sua ANTHROPIC_API_KEY
npm start              # http://localhost:3000
```

Variáveis opcionais: `PORT` (padrão 3000) e `CLAUDE_MODEL` (padrão `claude-opus-5-5`).

## Estrutura

| Arquivo | Função |
|---|---|
| `server.js` | Servidor Express com os endpoints `/api/collections`, `/api/analyze` e `/api/generate` (streaming NDJSON) |
| `src/instagram.js` | Cliente da API web do Instagram: lista coleções, pagina posts, baixa imagens |
| `src/analyzer.js` | Prompts e chamadas ao Claude (streaming, fallback automático em caso de recusa) |
| `public/` | Interface web (HTML/CSS/JS puro) |

## Limitações e avisos

- O Instagram **não tem API oficial para itens salvos**. O app usa os mesmos endpoints internos do
  site, que podem mudar sem aviso, e o acesso automatizado pode violar os Termos de Uso. Use com a sua
  própria conta e com moderação (o app pausa entre as páginas).
- O `sessionid` dá acesso total à conta. Ele é usado só durante a requisição e não é salvo, mas rode o app
  em ambiente confiável e saia da sessão no Instagram depois para invalidá-lo.
- Reels são analisados pela capa, legenda e métricas; o áudio/fala do vídeo não é transcrito.
  No modo manual, você pode colar a transcrição junto da legenda.
- Custo: cada imagem consome tokens. Ajuste *Máx. de imagens analisadas* para coleções grandes.
