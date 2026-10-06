// Transcrição local e gratuita das falas dos reels com Whisper (open source),
// rodando no próprio servidor via transformers.js. Nada é enviado a serviços
// pagos; na primeira execução o modelo é baixado do Hugging Face e fica em cache.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import ffmpegPath from "ffmpeg-static";
import { transcribe as groqTranscribe } from "./providers/groq.js";

const WHISPER_MODEL = process.env.WHISPER_MODEL || "Xenova/whisper-small";
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || "portuguese";
const MAX_SECONDS = 180;

let pipelinePromise = null;

function getTranscriber() {
  pipelinePromise ??= import("@huggingface/transformers")
    .then(({ pipeline, env }) => {
      if (process.env.WHISPER_CACHE_DIR) env.cacheDir = process.env.WHISPER_CACHE_DIR;
      return pipeline("automatic-speech-recognition", WHISPER_MODEL);
    })
    .catch((err) => {
      pipelinePromise = null;
      throw new Error(`Não foi possível carregar o Whisper (${WHISPER_MODEL}): ${err.message}`);
    });
  return pipelinePromise;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ["-v", "error", ...args]);
    const chunks = [];
    let stderr = "";
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", (c) => (stderr += c));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg falhou: ${stderr.trim().slice(0, 200)}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

// Converte qualquer vídeo/áudio em PCM mono 16 kHz (formato que o Whisper espera).
export async function decodeAudio(filePath) {
  const buf = await runFfmpeg(["-i", filePath, "-t", String(MAX_SECONDS), "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"]);
  const aligned = new Float32Array(Math.floor(buf.length / 4));
  new Uint8Array(aligned.buffer).set(buf.subarray(0, aligned.length * 4));
  return aligned;
}

// Extrai só o áudio em MP3 leve (bem menor que o vídeo) para enviar à Groq.
export function extractMp3(filePath) {
  return runFfmpeg(["-i", filePath, "-t", String(MAX_SECONDS), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "mp3", "pipe:1"]);
}

async function downloadToTemp(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download do vídeo falhou (${res.status})`);
  const file = path.join(os.tmpdir(), `appsalvos-${crypto.randomUUID()}.mp4`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// engine "groq": Whisper hospedado na Groq (rápido, precisa de chave gratuita).
// engine "local": Whisper rodando neste servidor (sem chave, mais lento).
export async function transcribeVideo(url, { engine = "local", groqKey } = {}) {
  const file = await downloadToTemp(url);
  try {
    if (engine === "groq") {
      const mp3 = await extractMp3(file);
      if (mp3.length < 2000) return "";
      return await groqTranscribe(groqKey, mp3);
    }
    const transcriber = await getTranscriber();
    const audio = await decodeAudio(file);
    if (audio.length < 16000) return "";
    const out = await transcriber(audio, {
      language: WHISPER_LANGUAGE,
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    return String(out?.text || "").trim();
  } finally {
    fs.unlink(file).catch(() => {});
  }
}

export { WHISPER_MODEL };
