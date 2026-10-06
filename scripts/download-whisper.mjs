// Pré-carrega o modelo do Whisper no cache (usado no build do Docker).
import { pipeline, env } from "@huggingface/transformers";

if (process.env.WHISPER_CACHE_DIR) env.cacheDir = process.env.WHISPER_CACHE_DIR;
const model = process.env.WHISPER_MODEL || "Xenova/whisper-small";
await pipeline("automatic-speech-recognition", model);
console.log(`Whisper pronto: ${model}`);
