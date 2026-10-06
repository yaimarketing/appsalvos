// Transcrição local e gratuita das falas dos reels com Whisper (open source),
// rodando no próprio servidor via transformers.js. Nada é enviado a serviços
// pagos; na primeira execução o modelo é baixado do Hugging Face e fica em cache.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import ffmpegPath from "ffmpeg-static";

const WHISPER_MODEL = process.env.WHISPER_MODEL || "Xenova/whisper-small";
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || "portuguese";
const MAX_SECONDS = 180;

let pipelinePromise = null;

function getTranscriber() {
  pipelinePromise ??= import("@huggingface/transformers")
    .then(({ pipeline }) => pipeline("automatic-speech-recognition", WHISPER_MODEL))
    .catch((err) => {
      pipelinePromise = null;
      throw new Error(`Não foi possível carregar o Whisper (${WHISPER_MODEL}): ${err.message}`);
    });
  return pipelinePromise;
}

// Converte qualquer vídeo/áudio em PCM mono 16 kHz (formato que o Whisper espera).
export function decodeAudio(filePath) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      "-v", "error",
      "-i", filePath,
      "-t", String(MAX_SECONDS),
      "-vn", "-ac", "1", "-ar", "16000",
      "-f", "f32le", "pipe:1",
    ]);
    const chunks = [];
    let stderr = "";
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", (c) => (stderr += c));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg falhou: ${stderr.trim().slice(0, 200)}`));
      const buf = Buffer.concat(chunks);
      const aligned = new Float32Array(buf.length / 4);
      new Uint8Array(aligned.buffer).set(buf.subarray(0, aligned.length * 4));
      resolve(aligned);
    });
  });
}

async function downloadToTemp(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download do vídeo falhou (${res.status})`);
  const file = path.join(os.tmpdir(), `appsalvos-${crypto.randomUUID()}.mp4`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

export async function transcribeVideo(url) {
  const transcriber = await getTranscriber();
  const file = await downloadToTemp(url);
  try {
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
