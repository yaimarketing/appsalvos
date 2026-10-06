const $ = (sel) => document.querySelector(sel);

let session = null;

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

function setStatus(el, message, kind = "") {
  el.textContent = message;
  el.className = `status ${kind}`;
}

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

async function copyWithFeedback(btn, text) {
  await copyText(text);
  const label = btn.textContent;
  btn.textContent = "Copiado!";
  setTimeout(() => (btn.textContent = label), 1500);
}

// ---------- Sessão ----------

function renderSession(info) {
  session = info;
  const ig = info.instagram;
  $("#ig-account").classList.toggle("on", ig.connected);
  $("#ig-label").textContent = ig.connected ? `Instagram: @${ig.username || "conectado"}` : "Instagram: desconectado";
  $("#ig-login-btn").hidden = ig.connected;
  $("#ig-logout-btn").hidden = !ig.connected;
  $("#link-section").hidden = !ig.connected;
  $("#connector-url").value = ig.connectorUrl || "";

  if (info.app.passwordMissing) {
    setStatus($("#status"), "Falta configurar a variável APP_PASSWORD no serviço de hospedagem (ex.: Render → Environment).", "error");
  } else if (info.app.locked) {
    openLock();
  }
}

async function refreshSession() {
  try {
    renderSession(await api("/api/session"));
  } catch {
    setStatus($("#status"), "Não foi possível falar com o servidor. Recarregue a página.", "error");
  }
}

// ---------- Instagram ----------

document.querySelectorAll("dialog [data-close]").forEach((btn) =>
  btn.addEventListener("click", () => btn.closest("dialog").close()),
);

// Login: usuário/senha (com etapa de código 2FA) ou sessionid colado.
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
    setStatus($("#status"), "Instagram conectado. Copie o link do conector abaixo.", "ok");
    $("#link-section").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setStatus($("#ig-error"), err.message, "error");
  } finally {
    submit.disabled = false;
  }
});

$("#ig-logout-btn").addEventListener("click", async () => {
  try {
    renderSession(await api("/api/instagram/logout", {}));
    setStatus($("#status"), "Você saiu do Instagram. O link antigo do conector não funciona mais.", "ok");
  } catch (err) {
    setStatus($("#status"), err.message, "error");
  }
});

$("#copy-link").addEventListener("click", (e) => copyWithFeedback(e.currentTarget, $("#connector-url").value));
$("#connector-url").addEventListener("focus", (e) => e.target.select());

// ---------- Passo a passo e exemplos ----------

document.querySelectorAll(".tab[data-ai]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab[data-ai]").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll("[data-ai-panel]").forEach((p) => (p.hidden = p.dataset.aiPanel !== tab.dataset.ai));
    prefs.set("ai", tab.dataset.ai);
  });
});
if (prefs.get("ai") === "chatgpt") document.querySelector('.tab[data-ai="chatgpt"]').click();

document.querySelectorAll("[data-copy-text]").forEach((btn) =>
  btn.addEventListener("click", () => copyWithFeedback(btn, btn.previousElementSibling.textContent)),
);

// ---------- Senha de acesso ao site ----------

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
  } catch (err) {
    setStatus($("#lock-error"), err.message, "error");
  }
});

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

showWarning().then(refreshSession);
