@echo off
REM Liga o AppSalvos no seu computador com endereco publico (Cloudflare Tunnel).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao encontrado. Instale em https://nodejs.org ^(versao LTS^) e rode de novo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Instalando dependencias pela primeira vez, aguarde...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Falha ao instalar as dependencias.
    pause
    exit /b 1
  )
)
node scripts\tunel.mjs
pause
