// Roda o AppSalvos no seu computador com um endereço público HTTPS grátis
// (Cloudflare Tunnel), para o Claude/ChatGPT alcançarem o conector.
// O acesso ao Instagram sai da sua internet de casa.
//
// Uso: npm run tunel   (no Windows, pode dar dois cliques em iniciar-windows.bat)
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const PORT = process.env.PORT || "3000";
const CLOUDFLARED = process.env.CLOUDFLARED_PATH || "cloudflared";

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// 1. O cloudflared está instalado?
const check = spawnSync(CLOUDFLARED, ["--version"], { encoding: "utf8" });
if (check.error || check.status !== 0) {
  fail(
    "Não encontrei o cloudflared.\n" +
      "  Windows: abra o PowerShell e rode:  winget install --id Cloudflare.cloudflared\n" +
      "  Mac:     brew install cloudflared\n" +
      "  Depois feche e abra o terminal (ou o iniciar-windows.bat) de novo.",
  );
}

// 2. Com endereço público, o site precisa de senha. Gera uma na primeira vez e guarda no .env.
let password = process.env.APP_PASSWORD;
if (!password) {
  password = crypto.randomBytes(6).toString("base64url");
  fs.appendFileSync(envFile, `${fs.existsSync(envFile) ? "\n" : ""}APP_PASSWORD=${password}\n`);
}

// 3. Abre o túnel e espera o endereço https://….trycloudflare.com.
console.log("Abrindo o túnel da Cloudflare…");
const tunnel = spawn(CLOUDFLARED, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`], {
  stdio: ["ignore", "pipe", "pipe"],
});
let server = null;

function shutdown(code = 0) {
  server?.kill();
  tunnel.kill();
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
tunnel.on("exit", (code) => {
  if (!server) fail(`O túnel fechou antes de ficar pronto (código ${code}). Verifique sua internet e tente de novo.`);
  console.error("\nO túnel caiu. Rode de novo para gerar um endereço novo.");
  shutdown(1);
});

const timeout = setTimeout(() => fail("O túnel demorou demais para responder. Tente de novo."), 60_000);

let buffer = "";
function onTunnelOutput(chunk) {
  if (server) return;
  buffer += chunk.toString();
  const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!match) return;
  clearTimeout(timeout);
  startServer(match[0]);
}
tunnel.stdout.on("data", onTunnelOutput);
tunnel.stderr.on("data", onTunnelOutput);

// 4. Liga o servidor do app sabendo qual é o endereço público.
function startServer(publicUrl) {
  server = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PORT, PUBLIC_URL: publicUrl, APP_PASSWORD: password, REQUIRE_APP_PASSWORD: "true" },
  });
  server.on("exit", (code) => shutdown(code ?? 0));

  const line = "─".repeat(64);
  console.log(`\n${line}`);
  console.log("  AppSalvos está no ar!");
  console.log(`  Abra no navegador:  ${publicUrl}`);
  console.log(`  Senha do site:      ${password}`);
  console.log("");
  console.log("  Deixe esta janela aberta enquanto usar o conector no Claude/ChatGPT.");
  console.log("  O endereço muda toda vez que você roda: conecte o Instagram de novo e");
  console.log("  atualize a URL do conector no Claude/ChatGPT.");
  console.log("  Para encerrar: Ctrl+C (ou feche a janela).");
  console.log(`${line}\n`);
}
