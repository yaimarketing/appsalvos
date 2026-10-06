const $ = (sel) => document.querySelector(sel);

const state = {
  source: "instagram",
  posts: [],
  analysis: "",
  output: "",
  busy: false,
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

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    state.source = tab.dataset.source;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $("#source-instagram").hidden = state.source !== "instagram";
    $("#source-manual").hidden = state.source !== "manual";
  });
});

$("#load-collections").addEventListener("click", async () => {
  const status = $("#status");
  setBusy(true);
  setStatus(status, "Buscando suas coleções…");
  try {
    const res = await fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: $("#sessionId").value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const list = $("#collection-list");
    list.innerHTML = "";
    for (const c of data.collections) {
      const opt = document.createElement("option");
      opt.value = c.name;
      opt.label = c.count != null ? `${c.name} (${c.count})` : c.name;
      list.appendChild(opt);
    }
    setStatus(status, `${data.collections.length} coleções encontradas: ${data.collections.map((c) => c.name).join(", ")}`, "ok");
    $("#collection").focus();
  } catch (err) {
    setStatus(status, err.message, "error");
  } finally {
    setBusy(false);
  }
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
      <p>${escapeHtml(p.caption.slice(0, 140))}${p.caption.length > 140 ? "…" : ""}</p>`;
    grid.appendChild(card);
  });
  $("#posts-count").textContent = `(${posts.length})`;
  $("#posts-section").hidden = false;
}

$("#analyze").addEventListener("click", async () => {
  const status = $("#status");
  const body = {
    source: state.source,
    sessionId: $("#sessionId").value,
    collection: $("#collection").value,
    manualText: $("#manualText").value,
    maxPosts: $("#maxPosts").value,
    maxImages: $("#maxImages").value,
  };
  if (state.source === "instagram" && (!body.sessionId.trim() || !body.collection.trim())) {
    setStatus(status, "Informe o sessionid e o nome da lista de salvos.", "error");
    return;
  }

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
        case "reset":
          state.analysis = "";
          live.set("");
          break;
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
        posts: state.posts.map((p) => ({ type: p.type, caption: p.caption })),
        format: $("#format").value,
        quantity: $("#quantity").value,
        brief: $("#brief").value,
      },
      (ev) => {
        if (ev.type === "delta") {
          state.output += ev.text;
          live.set(state.output);
        } else if (ev.type === "reset") {
          state.output = "";
          live.set("");
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
