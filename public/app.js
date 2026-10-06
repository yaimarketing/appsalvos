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
    transcribe: $("#transcribe").checked,
    maxTranscripts: $("#maxTranscripts").value,
  };
  if (state.source === "instagram") {
    if (!state.session?.instagram.connected) return openInstagramDialog();
    if (!body.collection.trim()) {
      setStatus(status, "Escolha a lista de salvos.", "error");
      return;
    }
  }
  const claude = state.session?.claude;
  if (claude && !claude.connected && !claude.serverKey) {
    $("#claude-login-btn").click();
    return;
  }
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

document.querySelectorAll("[data-copy]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    await navigator.clipboard.writeText(state[btn.dataset.copy] || "");
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

  const cl = info.claude;
  const claudeReady = cl.connected || cl.serverKey;
  $("#claude-account").classList.toggle("on", claudeReady);
  $("#claude-label").textContent = cl.connected
    ? "Claude: sua conta conectada"
    : cl.serverKey
      ? "Claude: usando a chave do servidor"
      : "Claude: desconectado";
  $("#claude-login-btn").hidden = cl.connected;
  $("#claude-logout-btn").hidden = !cl.connected;

  if (ig.connected && !igWasConnected) loadCollections();
  if (!ig.connected) $("#collection-list").innerHTML = "";
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
    const list = $("#collection-list");
    list.innerHTML = "";
    for (const c of data.collections) {
      const opt = document.createElement("option");
      opt.value = c.name;
      opt.label = c.count != null ? `${c.name} (${c.count})` : c.name;
      list.appendChild(opt);
    }
    setStatus(status, `${data.collections.length} coleções: ${data.collections.map((c) => c.name).join(", ")}`, "ok");
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

// Conta Claude: a pessoa cola a chave da API criada no Console da Anthropic.
$("#claude-login-btn").addEventListener("click", () => {
  $("#claude-key").value = "";
  setStatus($("#claude-error"), "", "error");
  $("#claude-dialog").showModal();
  $("#claude-key").focus();
});

$("#claude-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submit = $("#claude-submit");
  submit.disabled = true;
  setStatus($("#claude-error"), "Verificando a chave…", "");
  try {
    const info = await api("/api/claude/login", { apiKey: $("#claude-key").value });
    $("#claude-key").value = "";
    $("#claude-dialog").close();
    renderSession(info);
  } catch (err) {
    setStatus($("#claude-error"), err.message, "error");
  } finally {
    submit.disabled = false;
  }
});

$("#claude-logout-btn").addEventListener("click", async () => {
  renderSession(await api("/api/claude/logout", {}));
});

refreshSession();
