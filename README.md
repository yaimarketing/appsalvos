# AppSalvos

Conector que deixa o **Claude** ou o **ChatGPT** de cada pessoa ler as **listas de salvos (coleções)** de uma
conta do Instagram — legendas, métricas, imagens de capa e **as falas dos reels** — para analisar o que funciona
e criar conteúdos novos no mesmo estilo (carrosséis, roteiros de reel, posts, legendas).

A análise e a criação acontecem **dentro da IA que a pessoa já usa**, com a assinatura dela. O AppSalvos não
usa nenhuma chave de IA: ele só busca os posts e transcreve as falas dos reels (Whisper rodando no servidor).

> ⚠️ **Use uma conta secundária do Instagram.** O acesso é não oficial e automatizado; o Instagram pode
> bloquear ou banir a conta usada. Nunca conecte a conta principal nem contas de clientes. O site mostra
> esse aviso antes de ser usado.

## Como funciona

1. A pessoa abre o site do AppSalvos, lê o aviso, digita a senha de acesso e **conecta o Instagram**
   (usuário e senha, com código de verificação em duas etapas, ou colando o cookie `sessionid`).
2. O site mostra um **link de conector pessoal** (`https://…/mcp/…`).
3. Ela adiciona esse link no **Claude** (Configurações → Conectores → Adicionar conector personalizado) ou no
   **ChatGPT** (Configurações → Apps e conectores → Modo desenvolvedor → Criar, sem autenticação).
4. Na conversa, pede por exemplo: *"Use o AppSalvos para analisar minha lista 'Referências' e crie 3 carrosséis
   no mesmo estilo"*.

Ferramentas do conector:

| Ferramenta | O que faz |
|---|---|
| `listar_colecoes` | Lista as listas de salvos da conta |
| `buscar_posts` | Traz os posts de uma lista: tipo, autor, métricas, link, legenda e imagens de capa |
| `transcrever_reel` | Transcreve o que é falado num reel (um por chamada) |
| Prompt `analisar_colecao` | Roteiro pronto de análise + criação de conteúdos |

O link carrega os cookies da conta **criptografados** (AES-256-GCM com `APP_SECRET`): o servidor não guarda
nada e o link continua valendo depois de reinícios. Quem tiver o link acessa os salvos da conta, então ele não
deve ser compartilhado. **Sair** no site encerra a sessão no Instagram e invalida o link.

## Publicar online (Render, grátis)

Claude e ChatGPT só acessam o conector por um endereço público com HTTPS. O repositório já tem o
`render.yaml` para o [Render](https://render.com) (plano grátis, sem cartão), que publica de novo sozinho a
cada atualização da branch escolhida.

1. Crie uma conta em [render.com](https://render.com) entrando com o **GitHub**.
2. **New → Blueprint**, autorize o Render a ver o repositório `appsalvos` e selecione-o (branch `main`).
3. Preencha `APP_PASSWORD` (senha do site, **obrigatória**). O `APP_SECRET` é gerado automaticamente.
4. **Deploy Blueprint** e espere o status **Live**. O endereço fica como `https://appsalvos.onrender.com`.

Limitações do plano grátis: o servidor "dorme" após 15 min sem uso e leva ~1 min para acordar (a primeira
chamada do Claude/ChatGPT pode demorar ou falhar; é só pedir de novo). Com 512 MB de memória, o Whisper usa o
modelo menor, então a transcrição é mais simples. O Instagram desconfia mais de acessos vindos de servidores;
se o login com senha pedir verificação, use **Colar sessionid** da conta secundária.

O `Dockerfile` permite publicar em qualquer serviço com Docker.

## Rodando no computador (desenvolvimento)

Requer Node.js 22.9+.

```bash
npm install
cp .env.example .env   # opcional
npm start              # http://localhost:3000
```

Para o Claude/ChatGPT alcançarem o conector rodando no seu computador, é preciso expor a porta com um túnel
HTTPS (ex.: Cloudflare Tunnel) — para uso normal, prefira publicar no Render.

## Estrutura

| Arquivo | Função |
|---|---|
| `server.js` | Servidor Express: site, senha, login do Instagram e endpoint do conector (`/mcp/:token`) |
| `src/mcp.js` | Ferramentas e prompt do conector (MCP) |
| `src/prompts.js` | Instruções de análise e criação usadas pela IA |
| `src/token.js` | Criptografia do link do conector |
| `src/instagram.js` | Cliente da API web do Instagram: login, 2FA, logout, coleções, posts, imagens e vídeos |
| `src/transcriber.js` | Transcrição das falas com Whisper (transformers.js + ffmpeg) |
| `src/session.js` | Sessões do site em memória (cookie HttpOnly) |
| `public/` | Site (HTML/CSS/JS puro, responsivo) |
| `render.yaml` / `Dockerfile` | Publicação no Render / em serviços com Docker |

## Limitações

- O Instagram **não tem API oficial para itens salvos**; os endpoints internos podem mudar sem aviso e o uso
  automatizado viola os Termos de Uso. Use uma conta secundária, com moderação.
- Conectores personalizados dependem do plano do Claude ou do ChatGPT de cada pessoa.
