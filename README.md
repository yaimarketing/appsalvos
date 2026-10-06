# AppSalvos

App web que entra numa conta do Instagram, abre a **lista de salvos (coleção)** escolhida, analisa todos
os posts (legendas, métricas, imagens/capas e **as falas dos reels**) com IA e **gera conteúdos novos no
mesmo estilo**: carrosséis, roteiros de reel, posts estáticos ou legendas. Funciona no computador e no celular.

> ⚠️ **Use uma conta secundária do Instagram.** O app acessa o Instagram de forma não oficial e
> automatizada; o Instagram pode bloquear ou banir a conta usada. Nunca entre com a conta principal nem
> com contas de clientes. O app mostra esse aviso antes de ser usado.

## Motores de IA

| | Claude | Groq | Gemini | Ollama |
|---|---|---|---|---|
| Custo | Pago (Haiku 4.5) | Grátis com limites | Grátis com limites | Grátis |
| Onde roda | API da Anthropic | API da Groq | API do Google | No computador do app (não disponível online) |
| Lê imagens | Sim | Sim, até 5 por vez (Llama 4) | Sim | Depende do modelo |
| Chave | [console.anthropic.com](https://console.anthropic.com/settings/keys) | [console.groq.com](https://console.groq.com/keys) | [aistudio.google.com](https://aistudio.google.com/apikey) | — |

A transcrição das falas dos reels pode ser feita pelo **Whisper no servidor** (grátis, mais lento) ou pela
**Groq** (grátis, rápida, usa a mesma chave da Groq).

No plano gratuito do Gemini o Google pode usar os dados enviados para melhorar os produtos dele.

## Como funciona

1. **Aviso e senha:** ao abrir, o app mostra o aviso de conta secundária e, se configurada, pede a senha de acesso.
2. **Motor de IA** (topo da tela): escolha Claude, Groq, Gemini ou Ollama, conecte a chave e escolha o modelo.
3. **Instagram:** entre com usuário e senha (com código de verificação em duas etapas) ou colando o cookie `sessionid`.
4. **Lista de salvos:** escolha uma coleção da conta ou cole os posts manualmente.
5. **Análise:** relatório com temas, formatos, ganchos, roteiro e falas dos reels, tom de voz, identidade visual,
   CTAs e *fórmulas replicáveis*.
6. **Geração:** escolha formato, quantidade e descreva quem vai publicar.

## Publicar online (Render, grátis)

O repositório já tem o `render.yaml`, que configura tudo no [Render](https://render.com) (plano grátis, sem
cartão). O Render publica de novo sozinho a cada atualização da branch escolhida.

1. Crie uma conta em [render.com](https://render.com) clicando em **GitHub** para entrar.
2. Clique em **New → Blueprint**, autorize o Render a ver o repositório `appsalvos` e selecione-o
   (branch `main`).
3. O Render pede os valores das variáveis:
   - `APP_PASSWORD` — senha de acesso ao app (**obrigatória**; sem ela o app não libera nada online).
   - `GROQ_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` — opcionais; preenchidas, ninguém precisa colar
     a chave a cada acesso. Pode deixar em branco.
4. Clique em **Deploy Blueprint** e espere o status **Live** (alguns minutos).
5. Abra o endereço mostrado (ex.: `https://appsalvos.onrender.com`) no computador ou no celular.

Limitações do plano grátis: o app "dorme" após 15 min sem uso e leva ~1 min para acordar; ao dormir, os
logins (Instagram e chaves coladas) são perdidos. Com 512 MB de memória, o Whisper local usa o modelo
menor — prefira a transcrição pela **Groq**. O Instagram tende a desconfiar mais de acessos vindos de
servidores; se o login com senha pedir verificação, use **Colar sessionid** da conta secundária.

O `Dockerfile` também permite publicar em qualquer serviço com Docker (ex.: Hugging Face Spaces, hoje pago).

## Rodando no computador

Requer Node.js 22.9+.

```bash
npm install
cp .env.example .env   # opcional: senha, chaves, modelo do Whisper etc.
npm start              # http://localhost:3000
```

O terminal mostra o endereço para abrir no celular conectado ao mesmo Wi-Fi.

Para usar o **Ollama** (só no computador): instale em [ollama.com](https://ollama.com/download), rode
`ollama pull qwen2.5vl` e escolha *Ollama* no app.

## Estrutura

| Arquivo | Função |
|---|---|
| `server.js` | Servidor Express: senha, contas, chaves, coleções, análise e geração (streaming NDJSON) |
| `src/session.js` | Sessões em memória (cookie HttpOnly) com as credenciais de cada navegador |
| `src/instagram.js` | Cliente da API web do Instagram: login, 2FA, logout, coleções, posts, imagens e vídeos |
| `src/transcriber.js` | Transcrição com Whisper local (transformers.js + ffmpeg) ou pela Groq |
| `src/analyzer.js` | Prompts de análise e geração |
| `src/providers/` | Um módulo por motor de IA (Claude, Groq, Gemini, Ollama) |
| `public/` | Interface web (HTML/CSS/JS puro, responsiva) |
| `render.yaml` | Configuração do Render (deploy grátis) |
| `Dockerfile` | Imagem Docker opcional para outros serviços |

## Limitações

- O Instagram **não tem API oficial para itens salvos**; os endpoints internos podem mudar sem aviso e o uso
  automatizado viola os Termos de Uso. Use uma conta secundária, com moderação.
- Senha do Instagram, cookies e chaves ficam só na memória do servidor durante a sessão (12 h ou até **Sair**).
- Planos gratuitos (Groq, Gemini) têm limite por minuto e por dia; coleções grandes podem estourar o limite.
  Reduza posts e imagens se aparecer esse aviso.
