const $ = (sel) => document.querySelector(sel);

const state = {
  source: "instagram",
  posts: [],
  analysis: "",
  output: "",
  busy: false,
  session: null,
};

// Renderiza Markdown vindo do modelo sem permitir HTML bruto.
const renderer = new marked.Renderer();
renderer.html = ({ text }) => escapeHtml(text);
const defaultLink = renderer.link.bind(renderer);
renderer.link = (token) => (/^https?:\/\//i.test(token.href) ? defaultLink(token) : escapeHtml(token.text));
marked.use({ renderer, gfm: true, breaks: false });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderMarkdown(el, text) {
  el.innerHTML = marked.parse(text);
}

function setStatus(el, message, kind = "") {
  el.textContent = message;
  el.className = `status ${kind}`;
}

function setBusy(busy) {
  state.busy = busy;
  for (const id of ["#analyze", "#generate", "#load-collections"]) $(id).disabled = busy;
}

// Lê uma resposta NDJSON linha a linha e entrega cada evento ao callback.
async function streamEvents(url, body, onEvent) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`Falha na requisição (${res.status}).`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

// Atualiza o Markdown no máximo uma vez por quadro durante o streaming.
function liveRenderer(el) {
  let pending = false;
  let text = "";
  return {
    set(value) {
      text = value;
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        renderMarkdown(el, text);
      });
    },
  };
}

document.querySelectorAll(".tab[data-source]").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.source = tab.dataset.source;
    document.querySelectorAll(".tab[data-source]").forEach((t) => t.classList.toggle("active", t === tab));
    $("#source-instagram").hidden = state.source !== "instagram";
    $("#source-manual").hidden = state.source !== "manual";
  });
});

function renderPosts(posts) {
  const grid = $("#posts");
  grid.innerHTML = "";
  posts.forEach((p, i) => {
    const card = document.createElement(p.url ? "a" : "div");
    card.className = "post";
    if (p.url) {
      card.href = p.url;
      card.target = "_blank";
      card.rel = "noopener";
    }
    const metrics = [p.likes != null && `♥ ${p.likes}`, p.comments != null && `💬 ${p.comments}`, p.views != null && `▶ ${p.views}`]
      .filter(Boolean)
      .join("  ");
    card.innerHTML = `
      ${p.thumbnail ? `<img loading="lazy" referrerpolicy="no-referrer" alt="" src="${escapeHtml(p.thumbnail)}" />` : `<div class="noimg">${escapeHtml(p.type)}</div>`}
      <div class="post-meta"><b>#${i + 1}</b> · ${escapeHtml(p.type)}${p.author ? ` · @${escapeHtml(p.author)}` : ""}</div>
      ${metrics ? `<div class="post-meta">${escapeHtml(metrics)}</div>` : ""}
      <p>${escapeHtml(p.caption.slice(0, 140))}${p.caption.length > 140 ? "…" : ""}</p>
      ${p.transcript ? `<p class="transcript" title="${escapeHtml(p.transcript)}">🎙 ${escapeHtml(p.transcript.slice(0, 120))}${p.transcript.length > 120 ? "…" : ""}</p>` : ""}`;
    grid.appendChild(card);
  });
  $("#posts-count").textContent = `(${posts.length})`;
  $("#posts-section").hidden = false;
}

$("#analyze").addEventListener("click", async () => {
  const status = $("#status");
  const body = {
    source: state.source,
    collection: $("#collection").value,
    manualText: $("#manualText").value,
    maxPosts: $("#maxPosts").value,
    maxImages: $("#maxImages").value,
    transcribe: $("#transcriber").value !== "off",
    transcriber: $("#transcriber").value,
    maxTranscripts: $("#maxTranscripts").value,
  };
  if (state.source === "instagram") {
    if (!state.session?.instagram.connected) return openInstagramDialog();
    if (!body.collection) {
      setStatus(status, "Escolha a lista de salvos.", "error");
      return;
    }
  }
  if (!aiReady(status)) return;
  Object.assign(body, aiParams());
  $("#warnings").innerHTML = "";

  setBusy(true);
  state.analysis = "";
  $("#analysis").innerHTML = "";
  $("#generate-section").hidden = true;
  const live = liveRenderer($("#analysis"));
  let failed = false;

  try {
    await streamEvents("/api/analyze", body, (ev) => {
      switch (ev.type) {
        case "progress":
          setStatus(status, ev.message);
          break;
        case "posts":
          state.posts = ev.posts;
          renderPosts(ev.posts);
          $("#analysis-section").hidden = false;
          break;
        case "warning": {
          const li = document.createElement("li");
          li.textContent = ev.message;
          $("#warnings").appendChild(li);
          break;
        }
        case "delta":
          state.analysis += ev.text;
          live.set(state.analysis);
          break;
        case "done":
          state.analysis = ev.analysis;
          renderMarkdown($("#analysis"), state.analysis);
          break;
        case "error":
          failed = true;
          setStatus(status, ev.message, "error");
          refreshSession();
          break;
      }
    });
    if (!failed && state.analysis) {
      setStatus(status, "Análise concluída.", "ok");
      $("#generate-section").hidden = false;
    }
  } catch (err) {
    setStatus(status, err.message, "error");
  } finally {
    setBusy(false);
  }
});

$("#generate").addEventListener("click", async () => {
  const status = $("#gen-status");
  if (!aiReady(status)) return;
  setBusy(true);
  state.output = "";
  $("#output").innerHTML = "";
  $("#output-wrap").hidden = false;
  const live = liveRenderer($("#output"));
  setStatus(status, "Criando conteúdos…");
  let failed = false;

  try {
    await streamEvents(
      "/api/generate",
      {
        analysis: state.analysis,
        posts: state.posts.map((p) => ({ type: p.type, caption: p.caption, transcript: p.transcript })),
        format: $("#format").value,
        quantity: $("#quantity").value,
        brief: $("#brief").value,
        ...aiParams(),
      },
      (ev) => {
        if (ev.type === "delta") {
          state.output += ev.text;
          live.set(state.output);
        } else if (ev.type === "done") {
          state.output = ev.text;
          renderMarkdown($("#output"), state.output);
        } else if (ev.type === "error") {
          failed = true;
          setStatus(status, ev.message, "error");
        }
      },
    );
    if (!failed) setStatus(status, "Pronto! Gere de novo para ter outras variações.", "ok");
  } catch (err) {
    setStatus(status, err.message, "error");
  } finally {
    setBusy(false);
  }
});

// navigator.clipboard só existe em HTTPS/localhost; pelo IP da rede local
// (ex.: abrindo no celular) usamos o método antigo de cópia.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      return await navigator.clipboard.writeText(text);
    } catch {
      // sem permissão: tenta o método antigo abaixo
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    await copyText(state[btn.dataset.copy] || "");
    const label = btn.textContent;
    btn.textContent = "Copiado!";
    setTimeout(() => (btn.textContent = label), 1500);
  });
});

document.querySelectorAll("[data-download]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.download;
    const blob = new Blob([state[key] || ""], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = key === "analysis" ? "analise-colecao.md" : "conteudos-gerados.md";
    a.click();
    URL.revokeObjectURL(a.href);
  });
});

// ---------- Contas (Instagram e Claude) ----------

async function api(url, body) {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Falha na requisição (${res.status}).`);
  return data;
}

function renderSession(info) {
  const igWasConnected = state.session?.instagram.connected;
  state.session = info;
  const ig = info.instagram;
  $("#ig-account").classList.toggle("on", ig.connected);
  $("#ig-label").textContent = ig.connected ? `Instagram: @${ig.username || "conectado"}` : "Instagram: desconectado";
  $("#ig-login-btn").hidden = ig.connected;
  $("#ig-logout-btn").hidden = !ig.connected;
  $("#ig-hint").hidden = ig.connected;

  renderProviders();
  if (info.app.passwordMissing) setStatus($("#status"), "Falta configurar a variável APP_PASSWORD no serviço de hospedagem (ex.: Render → Environment).", "error");
  else if (info.app.locked) openLock();

  if (ig.connected && !igWasConnected) loadCollections();
  if (!ig.connected) setCollectionOptions([], "Entre no Instagram para ver suas listas");
}

function setCollectionOptions(collections, placeholder) {
  const select = $("#collection");
  const previous = select.value;
  select.innerHTML = "";
  if (placeholder) select.add(new Option(placeholder, ""));
  for (const c of collections) {
    select.add(new Option(c.count != null ? `${c.name} (${c.count})` : c.name, c.id));
  }
  if ([...select.options].some((o) => o.value === previous)) select.value = previous;
}

async function refreshSession() {
  try {
    renderSession(await api("/api/session"));
  } catch {
    // servidor indisponível; a tela continua utilizável no modo manual
  }
}

async function loadCollections() {
  const status = $("#status");
  setStatus(status, "Buscando suas coleções…");
  try {
    const data = await api("/api/collections");
    setCollectionOptions(data.collections, "Escolha uma lista…");
    setStatus(status, `${data.collections.length} listas encontradas. Escolha uma acima.`, "ok");
  } catch (err) {
    setStatus(status, err.message, "error");
    refreshSession();
  }
}

$("#load-collections").addEventListener("click", () => {
  if (!state.session?.instagram.connected) return openInstagramDialog();
  loadCollections();
});

document.querySelectorAll("dialog [data-close]").forEach((btn) =>
  btn.addEventListener("click", () => btn.closest("dialog").close()),
);

// Login do Instagram: usuário/senha (com etapa de código 2FA) ou sessionid colado.
let igMode = "password";

function setIgMode(mode) {
  igMode = mode;
  document.querySelectorAll("[data-ig-mode]").forEach((t) => {
    t.classList.toggle("active", t.dataset.igMode === mode || (mode === "2fa" && t.dataset.igMode === "password"));
  });
  document.querySelectorAll("[data-ig-panel]").forEach((p) => (p.hidden = p.dataset.igPanel !== mode));
  $("#ig-submit").textContent = mode === "2fa" ? "Confirmar código" : "Entrar";
  setStatus($("#ig-error"), "", "error");
}

function openInstagramDialog() {
  setIgMode("password");
  $("#ig-password").value = "";
  $("#ig-code").value = "";
  $("#ig-dialog").showModal();
  $("#ig-username").focus();
}

document.querySelectorAll("[data-ig-mode]").forEach((tab) =>
  tab.addEventListener("click", () => setIgMode(tab.dataset.igMode)),
);

$("#ig-login-btn").addEventListener("click", openInstagramDialog);

$("#ig-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("#ig-submit");
  submit.disabled = true;
  setStatus($("#ig-error"), "Conectando…", "");
  try {
    let info;
    if (igMode === "password") {
      info = await api("/api/instagram/login", { username: $("#ig-username").value, password: $("#ig-password").value });
      if (info.twoFactorRequired) {
        setIgMode("2fa");
        $("#ig-2fa-text").textContent =
          info.method === "SMS"
            ? `Enviamos um código por SMS${info.phoneHint ? ` para ${info.phoneHint}` : ""}. Digite-o abaixo.`
            : "Digite o código do seu app autenticador.";
        $("#ig-code").focus();
        return;
      }
    } else if (igMode === "2fa") {
      info = await api("/api/instagram/2fa", { code: $("#ig-code").value });
    } else {
      info = await api("/api/instagram/session", { sessionId: $("#ig-sessionid").value });
    }
    $("#ig-password").value = "";
    $("#ig-sessionid").value = "";
    $("#ig-dialog").close();
    renderSession(info);
  } catch (err) {
    setStatus($("#ig-error"), err.message, "error");
  } finally {
    submit.disabled = false;
  }
});

$("#ig-logout-btn").addEventListener("click", async () => {
  renderSession(await api("/api/instagram/logout", {}));
  setStatus($("#status"), "Você saiu do Instagram.", "ok");
});

// ---------- Motor de IA: Claude, Groq, Gemini ou Ollama ----------

const prefs = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // sem armazenamento local (aba anônima etc.)
    }
  },
};

const PROVIDER_TEXT = {
  claude: {
    option: "Claude (pago)",
    steps: [
      'Abra o <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Console da Anthropic</a> e entre (ou crie) sua conta.',
      "Clique em <b>Create Key</b>, copie a chave (começa com <code>sk-ant-</code>) e cole abaixo.",
    ],
    cost: "O uso é cobrado na sua conta da Anthropic (Claude Haiku 4.5, o modelo mais barato do Claude).",
  },
  groq: {
    option: "Groq (grátis)",
    steps: [
      'Abra o <a href="https://console.groq.com/keys" target="_blank" rel="noopener">GroqCloud</a> e entre com Google ou e-mail.',
      "Clique em <b>Create API Key</b>, copie a chave (começa com <code>gsk_</code>) e cole abaixo.",
    ],
    cost: "Plano gratuito com limite por minuto e por dia. Analisa até 5 imagens por vez. A mesma chave libera a transcrição rápida dos reels.",
  },
  gemini: {
    option: "Gemini (grátis)",
    steps: [
      'Abra o <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> e entre com sua conta Google.',
      "Clique em <b>Criar chave de API</b>, copie a chave e cole abaixo.",
    ],
    cost: "Plano gratuito com limite diário. No plano gratuito o Google pode usar os dados enviados para melhorar os produtos dele.",
  },
  ollama: { option: "Ollama (grátis, local)" },
};

const currentProvider = () => $("#provider").value;

function setupProviderSelect(providers) {
  const select = $("#provider");
  if (select.options.length) return;
  for (const id of Object.keys(providers)) select.add(new Option(PROVIDER_TEXT[id]?.option || providers[id].label, id));
  const saved = prefs.get("provider");
  if (saved && providers[saved]) select.value = saved;
}

function providerReady(id = currentProvider()) {
  const p = state.session?.providers?.[id];
  return Boolean(p && (!p.needsKey || p.connected || p.serverKey));
}

function renderProviders() {
  const providers = state.session.providers;
  setupProviderSelect(providers);
  const id = currentProvider();
  const p = providers[id];
  const ready = providerReady(id);
  $("#ai-account").classList.toggle("on", ready && (id !== "ollama" || $("#model").options.length > 0));
  $("#ai-label").textContent = !p.needsKey
    ? `${p.label}: roda no computador do servidor`
    : p.connected
      ? `${p.label}: sua chave conectada`
      : p.serverKey
        ? `${p.label}: usando a chave do servidor`
        : `${p.label}: desconectado`;
  $("#key-login-btn").hidden = !p.needsKey || p.connected;
  $("#key-logout-btn").hidden = !p.connected;
  $("#models-refresh").hidden = id === "claude";
  // Transcrição pela Groq só aparece quando há chave da Groq.
  const groqOpt = $("#transcriber").querySelector('option[value="groq"]');
  groqOpt.disabled = !state.session.transcription.groqAvailable;
  if (groqOpt.disabled && $("#transcriber").value === "groq") $("#transcriber").value = "local";
  // Com a Groq disponível, ela vira o padrão (mais rápida e precisa), a menos que a pessoa já tenha escolhido.
  if (!groqOpt.disabled && !transcriberTouched) $("#transcriber").value = "groq";
}

let transcriberTouched = false;
$("#transcriber").addEventListener("change", () => (transcriberTouched = true));

let modelsFor = null;

async function loadModels(force = false) {
  const id = currentProvider();
  if (!force && modelsFor === id) return;
  modelsFor = id;
  const select = $("#model");
  const note = $("#ai-note");
  select.innerHTML = "";
  if (!providerReady(id)) {
    note.textContent = "Conecte a chave para escolher o modelo.";
    renderProviders();
    return;
  }
  note.textContent = "Carregando modelos…";
  try {
    const { models } = await api(`/api/models/${id}`);
    if (modelsFor !== id) return;
    for (const m of models) select.add(new Option(`${m.label}${m.vision ? " · lê imagens" : ""}`, m.id));
    const saved = prefs.get(`model:${id}`);
    if (saved && models.some((m) => m.id === saved)) select.value = saved;
    note.textContent = models.length
      ? id === "ollama"
        ? "Modelos que não leem imagens analisam só textos e falas."
        : ""
      : id === "ollama"
        ? "Nenhum modelo instalado. No computador do servidor rode: ollama pull qwen2.5vl"
        : "Nenhum modelo disponível.";
  } catch (err) {
    if (modelsFor === id) note.textContent = err.message;
  }
  renderProviders();
}

function aiParams() {
  return { provider: currentProvider(), model: $("#model").value };
}

function aiReady(statusEl) {
  const id = currentProvider();
  if (!providerReady(id)) {
    openKeyDialog();
    return false;
  }
  if (id === "ollama" && !$("#model").value) {
    setStatus(statusEl, "Nenhum modelo do Ollama disponível. Veja o aviso no topo da tela.", "error");
    return false;
  }
  return true;
}

function openKeyDialog() {
  const id = currentProvider();
  const text = PROVIDER_TEXT[id];
  if (!text?.steps) return;
  $("#key-title").textContent = `Conectar ${state.session.providers[id].label}`;
  $("#key-steps").innerHTML = text.steps.map((s) => `<li>${s}</li>`).join("");
  $("#key-cost").textContent = text.cost + " A chave fica só na memória do servidor durante a sessão.";
  $("#key-input").value = "";
  setStatus($("#key-error"), "", "error");
  $("#key-dialog").showModal();
  $("#key-input").focus();
}

$("#key-login-btn").addEventListener("click", openKeyDialog);

$("#key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("#key-submit");
  submit.disabled = true;
  setStatus($("#key-error"), "Verificando a chave…", "");
  try {
    const info = await api(`/api/keys/${currentProvider()}`, { apiKey: $("#key-input").value });
    $("#key-input").value = "";
    $("#key-dialog").close();
    renderSession(info);
    loadModels(true);
  } catch (err) {
    setStatus($("#key-error"), err.message, "error");
  } finally {
    submit.disabled = false;
  }
});

$("#key-logout-btn").addEventListener("click", async () => {
  renderSession(await api(`/api/keys/${currentProvider()}/logout`, {}));
  loadModels(true);
});

$("#provider").addEventListener("change", () => {
  prefs.set("provider", currentProvider());
  renderProviders();
  loadModels();
});
$("#model").addEventListener("change", () => prefs.set(`model:${currentProvider()}`, $("#model").value));
$("#models-refresh").addEventListener("click", () => loadModels(true));

// ---------- Senha de acesso ao app ----------

function openLock() {
  if (!$("#lock-dialog").open) $("#lock-dialog").showModal();
  $("#lock-password").focus();
}

$("#lock-dialog").addEventListener("cancel", (e) => e.preventDefault()); // não fecha com Esc

$("#lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus($("#lock-error"), "Verificando…", "");
  try {
    const info = await api("/api/app-login", { password: $("#lock-password").value });
    $("#lock-password").value = "";
    $("#lock-dialog").close();
    renderSession(info);
    loadModels(true);
  } catch (err) {
    setStatus($("#lock-error"), err.message, "error");
  }
});

// Dentro da página do Hugging Face o app roda num iframe e o navegador bloqueia
// o cookie de sessão; avisa para abrir o endereço direto.
if (window.top !== window.self) {
  $("#iframe-banner").hidden = false;
  $("#iframe-link").href = location.href;
}

// ---------- Aviso de conta secundária (antes de usar o app) ----------

function showWarning() {
  return new Promise((resolve) => {
    if (prefs.get("secondaryAccountAck") === "1") return resolve();
    const dialog = $("#warning-dialog");
    dialog.addEventListener("cancel", (e) => e.preventDefault()); // não fecha com Esc
    $("#warning-ack").addEventListener("change", (e) => ($("#warning-continue").disabled = !e.target.checked));
    $("#warning-form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!$("#warning-ack").checked) return;
      if ($("#warning-remember").checked) prefs.set("secondaryAccountAck", "1");
      dialog.close();
      resolve();
    });
    dialog.showModal();
  });
}

showWarning()
  .then(refreshSession)
  .then(() => {
    if (state.session && !state.session.app.locked) loadModels(true);
  });
