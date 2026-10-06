# Imagem para o Hugging Face Spaces (Docker). Também roda em qualquer serviço com Docker.
FROM node:22-slim

# O Hugging Face executa o container com o usuário de id 1000 (o usuário "node" da imagem).
USER node
WORKDIR /home/node/app

ENV NODE_ENV=production \
    PORT=7860 \
    OLLAMA_ENABLED=false \
    WHISPER_MODEL=Xenova/whisper-base \
    WHISPER_CACHE_DIR=/home/node/app/.cache/whisper

COPY --chown=node package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

COPY --chown=node . .

# Baixa o modelo do Whisper durante o build para a 1ª transcrição não demorar.
# Se falhar, o app baixa na primeira vez que transcrever.
RUN node scripts/download-whisper.mjs || echo "Aviso: Whisper será baixado no primeiro uso."

EXPOSE 7860
CMD ["node", "server.js"]
