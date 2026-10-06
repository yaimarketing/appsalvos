// Cliente mínimo para a API web (não oficial) do Instagram. O Instagram não
// oferece API pública para itens salvos, então replicamos as chamadas que o
// site instagram.com faz — inclusive o login — usando os cookies da conta.

const ORIGIN = "https://www.instagram.com";
const BASE = `${ORIGIN}/api/v1`;
// App ID público usado pelo cliente web do instagram.com.
const WEB_APP_ID = "936619743392459";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export const ALL_SAVED_ID = "__all__";

export class InstagramError extends Error {
  constructor(message, status, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// `auth` é um objeto { nomeDoCookie: valor } com os cookies da conta.
function cookieHeader(auth) {
  return Object.entries(auth)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function storeCookies(auth, res) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    if (!value || value === '""' || /max-age=0/i.test(line)) delete auth[name];
    else auth[name] = value;
  }
}

function headersFor(auth, extra = {}) {
  const headers = {
    "User-Agent": USER_AGENT,
    "X-IG-App-ID": WEB_APP_ID,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "*/*",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    Cookie: cookieHeader(auth),
    ...extra,
  };
  if (auth.csrftoken) headers["X-CSRFToken"] = auth.csrftoken;
  return headers;
}

async function parseJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new InstagramError("Resposta inesperada do Instagram (talvez peça verificação de login).", 502);
  }
}

const EXPIRED_MESSAGE = "Sessão do Instagram inválida ou expirada. Entre no instagram.com, copie o sessionid de novo e tente outra vez.";
const CHECKPOINT_MESSAGE =
  "O Instagram pediu uma verificação de segurança para essa conta. Abra o app do Instagram, confirme que foi você e tente de novo.";

// Registra o motivo da recusa nos logs do servidor (sem cookies), para facilitar o diagnóstico.
function logRefusal(path, status, detail) {
  console.warn(`[instagram] ${path} → ${status}${detail ? ` (${detail})` : ""}`);
}

async function igGet(auth, path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: headersFor(auth), redirect: "manual" });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") || "";
    logRefusal(path, res.status, `redireciona para ${location.split("?")[0] || "?"}`);
    if (/challenge|checkpoint/i.test(location)) throw new InstagramError(CHECKPOINT_MESSAGE, 403);
    throw new InstagramError(EXPIRED_MESSAGE, 401);
  }
  if (res.status === 429) {
    logRefusal(path, 429);
    throw new InstagramError("O Instagram limitou as requisições. Aguarde alguns minutos.", 429);
  }
  const body = await res.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    // Veio uma página HTML em vez de dados: identifica que página é, para o diagnóstico.
    const page = /challenge|checkpoint/i.test(body)
      ? "verificação de segurança"
      : /accounts\/login|loginForm|"login_page"/i.test(body)
        ? "página de login"
        : "página desconhecida";
    logRefusal(path, res.status, `HTML (${page})`);
    if (page === "verificação de segurança") throw new InstagramError(CHECKPOINT_MESSAGE, 403);
    if (res.status === 401 || res.status === 403 || page === "página de login") throw new InstagramError(EXPIRED_MESSAGE, 401);
    throw new InstagramError(
      `O Instagram respondeu com uma ${page} em vez de dados (código ${res.status} em ${path}).`,
      502,
    );
  }
  if (!res.ok || data.status === "fail") {
    logRefusal(path, res.status, data.message || data.error_type || "");
    if (data.message === "checkpoint_required" || data.checkpoint_url || data.challenge) {
      throw new InstagramError(CHECKPOINT_MESSAGE, 403);
    }
    if (data.message === "login_required" || data.require_login || res.status === 401) {
      throw new InstagramError(EXPIRED_MESSAGE, 401);
    }
    // 403 sem "login_required" costuma ser um endereço bloqueado para o site, não sessão inválida.
    throw new InstagramError(`O Instagram recusou a solicitação (${res.status}${data.message ? `: ${data.message}` : ""}).`, res.status === 403 ? 403 : 502);
  }
  return data;
}

async function igPostForm(auth, path, fields) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: headersFor(auth, {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${ORIGIN}/accounts/login/`,
    }),
    body: new URLSearchParams(fields),
    redirect: "manual",
  });
  storeCookies(auth, res);
  if (res.status === 429) {
    throw new InstagramError("Muitas tentativas de login. Aguarde alguns minutos.", 429);
  }
  return parseJson(res);
}

// ---------- Login ----------

// Resultado: { auth, username } quando conectado, ou
// { twoFactor: { identifier, username, method }, auth } quando o Instagram pede o código.
export async function login(username, password) {
  username = String(username || "").trim().replace(/^@/, "");
  if (!username || !password) throw new InstagramError("Informe usuário e senha.", 400);

  // 1. Abre a página de login para receber o cookie csrftoken.
  const auth = {};
  const page = await fetch(`${ORIGIN}/accounts/login/`, { headers: { "User-Agent": USER_AGENT } });
  storeCookies(auth, page);
  if (!auth.csrftoken) {
    const html = await page.text();
    const token = html.match(/"csrf_token":"([^"]+)"/)?.[1];
    if (token) auth.csrftoken = token;
  }
  if (!auth.csrftoken) throw new InstagramError("Não foi possível iniciar o login no Instagram.", 502);

  // 2. Envia as credenciais do mesmo jeito que o site (senha no formato "versão 0").
  const timestamp = Math.floor(Date.now() / 1000);
  const data = await igPostForm(auth, "/web/accounts/login/ajax/", {
    username,
    enc_password: `#PWD_INSTAGRAM_BROWSER:0:${timestamp}:${password}`,
    queryParams: "{}",
    optIntoOneTap: "false",
    trustedDeviceRecords: "{}",
  });
  return handleLoginResponse(auth, data, username);
}

export async function verifyTwoFactor(pending, code) {
  const verificationCode = String(code || "").replace(/\s/g, "");
  if (!/^\d{4,8}$/.test(verificationCode)) throw new InstagramError("Digite o código numérico.", 400);
  const auth = { ...pending.auth };
  const data = await igPostForm(auth, "/web/accounts/login/ajax/two_factor/", {
    identifier: pending.identifier,
    username: pending.username,
    verificationCode,
    queryParams: "{}",
    trust_signal: "true",
  });
  return handleLoginResponse(auth, data, pending.username);
}

function handleLoginResponse(auth, data, username) {
  if (data.authenticated && auth.sessionid) {
    return { auth, username };
  }
  if (data.two_factor_required && data.two_factor_info) {
    const info = data.two_factor_info;
    return {
      auth,
      twoFactor: {
        identifier: info.two_factor_identifier,
        username: info.username || username,
        method: info.totp_two_factor_on ? "app autenticador" : "SMS",
        phoneHint: info.obfuscated_phone_number || null,
      },
    };
  }
  if (data.message === "checkpoint_required" || data.checkpoint_url) {
    throw new InstagramError(
      "O Instagram pediu uma verificação de segurança. Abra o app do Instagram, confirme que foi você e tente de novo — ou use a opção \"Colar sessionid\".",
      403,
    );
  }
  if (data.user === false) throw new InstagramError("Usuário não encontrado.", 401);
  if (data.authenticated === false) throw new InstagramError("Senha incorreta.", 401);
  if (data.error_type === "invalid_verification_code" || /code/i.test(data.message || "")) {
    throw new InstagramError("Código inválido ou expirado.", 401);
  }
  throw new InstagramError(`Login recusado pelo Instagram: ${data.message || "erro desconhecido"}`, 401);
}

// Alternativa ao login com senha: o usuário cola o cookie sessionid do navegador.
export function authFromSessionId(raw) {
  let value = String(raw || "").trim();
  // Aceita o valor puro ou um trecho do header Cookie ("sessionid=...; ...").
  const match = value.match(/sessionid=([^;\s]+)/);
  if (match) value = match[1];
  try {
    value = decodeURIComponent(value);
  } catch {
    // mantém como veio
  }
  if (!value || /[\s;]/.test(value)) {
    throw new InstagramError("Informe um sessionid válido.", 400);
  }
  const auth = { sessionid: encodeURIComponent(value) };
  const userId = value.split(":")[0];
  if (/^\d+$/.test(userId)) auth.ds_user_id = userId;
  return auth;
}

// Confere a sessão e descobre o @ da conta. Tenta os endereços que o próprio
// site do Instagram usa; só desiste se todos recusarem.
export async function currentUsername(auth) {
  const attempts = [
    async () => (await igGet(auth, "/accounts/edit/web_form_data/")).form_data?.username,
    async () => (await igGet(auth, "/accounts/current_user/", { edit: "true" })).user?.username,
    async () => (auth.ds_user_id ? (await igGet(auth, `/users/${auth.ds_user_id}/info/`)).user?.username : null),
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const username = await attempt();
      if (username) return username;
    } catch (err) {
      // Sessão inválida ou verificação de segurança valem para todos os endereços: não adianta insistir.
      if (err instanceof InstagramError && (err.status === 401 || err.message === CHECKPOINT_MESSAGE)) throw err;
      lastError = err;
    }
  }
  throw lastError || new InstagramError(EXPIRED_MESSAGE, 401);
}

// Encerra a sessão no Instagram (melhor esforço) para invalidar o cookie.
export async function logout(auth) {
  try {
    await igPostForm(auth, "/web/accounts/logout/ajax/", { one_tap_app_login: "0", user_id: auth.ds_user_id || "" });
  } catch {
    // a sessão local é descartada de qualquer forma
  }
}

// ---------- Salvos ----------

export async function listCollections(auth) {
  const collections = [];
  let maxId;
  for (let page = 0; page < 20; page++) {
    const data = await igGet(auth, "/collections/list/", {
      collection_types: JSON.stringify(["ALL_MEDIA_AUTO_COLLECTION", "MEDIA"]),
      max_id: maxId,
    });
    for (const c of data.items || []) {
      const isAll = c.collection_type === "ALL_MEDIA_AUTO_COLLECTION";
      collections.push({
        id: isAll ? ALL_SAVED_ID : String(c.collection_id),
        name: isAll ? "Todos os salvos" : c.collection_name,
        count: c.collection_media_count ?? null,
      });
    }
    if (!data.more_available || !data.next_max_id) break;
    maxId = data.next_max_id;
  }
  if (!collections.some((c) => c.id === ALL_SAVED_ID)) {
    collections.unshift({ id: ALL_SAVED_ID, name: "Todos os salvos", count: null });
  }
  return collections;
}

export async function findCollection(auth, nameOrId) {
  const wanted = String(nameOrId || "").trim();
  const collections = await listCollections(auth);
  const norm = (s) =>
    String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const found =
    collections.find((c) => c.id === wanted) ||
    collections.find((c) => norm(c.name) === norm(wanted));
  if (!found) {
    const names = collections.map((c) => `"${c.name}"`).join(", ");
    throw new InstagramError(`Coleção "${wanted}" não encontrada. Disponíveis: ${names}`, 404);
  }
  return found;
}

export async function fetchCollectionPosts(auth, collectionId, { limit = 50, onProgress } = {}) {
  const path =
    collectionId === ALL_SAVED_ID ? "/feed/saved/posts/" : `/feed/collection/${collectionId}/posts/`;
  const posts = [];
  let maxId;
  while (posts.length < limit) {
    const data = await igGet(auth, path, { max_id: maxId });
    for (const item of data.items || []) {
      const media = item.media || item;
      if (media?.id) posts.push(normalizeMedia(media));
      if (posts.length >= limit) break;
    }
    onProgress?.(posts.length);
    if (!data.more_available || !data.next_max_id) break;
    maxId = data.next_max_id;
    // Pausa curta entre páginas para não acionar o limite do Instagram.
    await new Promise((r) => setTimeout(r, 800));
  }
  return posts;
}

// ---------- Post avulso (pelo link) ----------

const SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function shortcodeFromUrl(url) {
  const match = String(url || "").match(/instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (match) return match[1];
  return /^[A-Za-z0-9_-]{5,}$/.test(String(url || "").trim()) ? String(url).trim() : null;
}

// O código do link (ex.: "C8xYz...") é o ID numérico do post em base64.
export function shortcodeToMediaId(code) {
  let id = 0n;
  for (const ch of code.slice(0, 11)) {
    const v = SHORTCODE_ALPHABET.indexOf(ch);
    if (v < 0) throw new InstagramError("Link de post inválido.", 400);
    id = id * 64n + BigInt(v);
  }
  return id.toString();
}

export async function fetchPostByUrl(auth, url) {
  const code = shortcodeFromUrl(url);
  if (!code) throw new InstagramError("Informe o link de um post ou reel do Instagram.", 400);
  const data = await igGet(auth, `/media/${shortcodeToMediaId(code)}/info/`);
  const media = data.items?.[0];
  if (!media) throw new InstagramError("Post não encontrado.", 404);
  return normalizeMedia(media);
}

const MEDIA_TYPES = { 1: "imagem", 2: "vídeo", 8: "carrossel" };

function pickImage(versions) {
  const candidates = versions?.candidates || [];
  if (!candidates.length) return null;
  // Menor imagem com pelo menos 480px de largura: suficiente para a análise
  // visual e bem mais barata em tokens que a versão 1080px.
  const sorted = [...candidates].sort((a, b) => a.width - b.width);
  return (sorted.find((c) => c.width >= 480) || sorted[sorted.length - 1]).url;
}

function pickVideo(versions) {
  if (!versions?.length) return null;
  // A menor versão basta: só o áudio é usado na transcrição.
  return [...versions].sort((a, b) => (a.width || 0) - (b.width || 0))[0].url;
}

function normalizeMedia(m) {
  const isReel = m.media_type === 2 && (m.product_type === "clips" || m.product_type === "igtv");
  const carousel = m.carousel_media || [];
  const images = carousel.length
    ? carousel.map((c) => pickImage(c.image_versions2)).filter(Boolean)
    : [pickImage(m.image_versions2)].filter(Boolean);
  return {
    id: String(m.id),
    url: m.code ? `https://www.instagram.com/p/${m.code}/` : null,
    author: m.user?.username || null,
    type: isReel ? "reel" : MEDIA_TYPES[m.media_type] || "post",
    caption: m.caption?.text || "",
    likes: m.like_count ?? null,
    comments: m.comment_count ?? null,
    views: m.play_count ?? m.view_count ?? null,
    videoDuration: m.video_duration ? Math.round(m.video_duration) : null,
    slides: carousel.length || null,
    takenAt: m.taken_at ? new Date(m.taken_at * 1000).toISOString().slice(0, 10) : null,
    images,
    videoUrl: m.media_type === 2 ? pickVideo(m.video_versions) : null,
    transcript: null,
  };
}

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Baixa as imagens no servidor e devolve em base64: as URLs do CDN do
// Instagram são assinadas e nem sempre acessíveis a partir de terceiros.
export async function downloadImage(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return null;
    const mediaType = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4.5 * 1024 * 1024) return null;
    return { mediaType, data: buf.toString("base64") };
  } catch {
    return null;
  }
}
