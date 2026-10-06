# AppSalvos

App web que entra na sua conta do Instagram, abre a **lista de salvos (coleção)** que você escolher,
analisa todos os posts dessa lista (legendas, métricas, imagens/capas e **as falas dos reels**) com o
Claude Haiku 4.5 e **gera conteúdos novos no mesmo estilo**: carrosséis, roteiros de reel, posts
estáticos ou legendas.

## Como funciona

1. **Contas** (barra no topo da tela)
   - **Entrar no Instagram:** com usuário e senha (inclui o código de verificação em duas etapas) ou
     colando o cookie `sessionid`. **Sair** encerra a sessão no Instagram e no app.
   - **Entrar com sua conta Claude:** cole uma chave da API criada no
     [Console da Anthropic](https://console.anthropic.com/settings/keys). O uso é cobrado na sua conta.
     **Sair** remove a chave da sessão.
2. **Fonte dos salvos:** escolha uma coleção da sua conta ou cole os posts manualmente (link + legenda/fala, separados por `---`).
3. **Transcrição dos reels:** o áudio de cada reel é transcrito **no próprio servidor** com o Whisper
   (open source, gratuito, sem enviar o áudio para nenhum serviço pago).
4. **Análise:** o Claude recebe legendas, transcrições, métricas e imagens e devolve um relatório com temas,
   formatos, ganchos, roteiro e falas dos reels, tom de voz, identidade visual, CTAs e *fórmulas replicáveis*.
5. **Geração:** escolha formato, quantidade e descreva quem vai publicar. O Claude cria conteúdos originais
   aplicando as fórmulas da análise.

## Rodando

Requer Node.js 22.9+.

```bash
npm install
cp .env.example .env   # opcional: ajuste porta, modelo do Whisper etc.
npm start              # http://localhost:3000
```

Na primeira transcrição o modelo do Whisper (~250 MB no `whisper-small`) é baixado do Hugging Face e
fica em cache. Para transcrever mais rápido em máquinas modestas, use `WHISPER_MODEL=Xenova/whisper-base`.

Se você definir `ANTHROPIC_API_KEY` no `.env`, quem não conectar a própria conta Claude usa essa chave.

## Estrutura

| Arquivo | Função |
|---|---|
| `server.js` | Servidor Express: login/logout, coleções, análise e geração (streaming NDJSON) |
| `src/session.js` | Sessões em memória (cookie HttpOnly) com as credenciais de cada navegador |
| `src/instagram.js` | Cliente da API web do Instagram: login, 2FA, logout, coleções, posts, imagens e vídeos |
| `src/transcriber.js` | Transcrição local com Whisper (transformers.js) + ffmpeg |
| `src/analyzer.js` | Prompts e chamadas ao Claude Haiku 4.5 |
| `public/` | Interface web (HTML/CSS/JS puro) |

## Limitações e avisos

- O Instagram **não tem API oficial para itens salvos**. O app usa os mesmos endpoints internos do site,
  que podem mudar sem aviso, e o acesso automatizado pode violar os Termos de Uso. Use com a sua própria
  conta e com moderação.
- O login com senha pode cair em uma verificação de segurança ("checkpoint"). Nesse caso, confirme no app
  do Instagram e tente de novo, ou use a opção **Colar sessionid**.
- Senha, cookies e chave da API ficam só na memória do servidor durante a sessão (12 h ou até clicar em
  **Sair**). Rode o app em um ambiente confiável.
- A transcrição roda na CPU: cada reel de 30–60 s leva alguns segundos (mais no primeiro uso). Limite a
  quantidade em *Máx. de reels transcritos*.
