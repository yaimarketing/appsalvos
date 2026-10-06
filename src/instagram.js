// Cliente mínimo para a API web (não oficial) do Instagram, usando o cookie
// de sessão do próprio usuário. O Instagram não oferece API pública para
// itens salvos, então replicamos as chamadas que o site instagram.com faz.

const BASE = "https://www.instagram.com/api/v1";
// App ID público usado pelo cliente web do instagram.com.
const WEB_APP_ID = "936619743392459";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export const ALL_SAVED_ID = "__all__";

export class InstagramError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function headersFor(sessionId) {
  return {
    "User-Agent": USER_AGENT,
    "X-IG-App-ID": WEB_APP_ID,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "*/*",
    Referer: "https://www.instagram.com/",
    Cookie: `sessionid=${sessionId}`,
  };
}

async function igGet(sessionId, path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: headersFor(sessionId), redirect: "manual" });

  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
    throw new InstagramError(
      "Sessão do Instagram inválida ou expirada. Gere um novo sessionid e tente de novo.",
      401,
    );
  }
  if (res.status === 429) {
    throw new InstagramError("O Instagram limitou as requisições. Aguarde alguns minutos.", 429);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InstagramError("Resposta inesperada do Instagram (talvez peça verificação de login).", 502);
  }
  if (!res.ok || data.status === "fail") {
    if (data.message === "login_required" || data.require_login) {
      throw new InstagramError("Sessão do Instagram inválida ou expirada.", 401);
    }
    throw new InstagramError(`Erro do Instagram: ${data.message || res.status}`, 502);
  }
  return data;
}

export function normalizeSessionId(raw) {
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
  return encodeURIComponent(value);
}

export async function listCollections(sessionId) {
  const collections = [];
  let maxId;
  for (let page = 0; page < 20; page++) {
    const data = await igGet(sessionId, "/collections/list/", {
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

export async function findCollection(sessionId, nameOrId) {
  const wanted = String(nameOrId || "").trim();
  const collections = await listCollections(sessionId);
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

export async function fetchCollectionPosts(sessionId, collectionId, { limit = 50, onProgress } = {}) {
  const path =
    collectionId === ALL_SAVED_ID ? "/feed/saved/posts/" : `/feed/collection/${collectionId}/posts/`;
  const posts = [];
  let maxId;
  while (posts.length < limit) {
    const data = await igGet(sessionId, path, { max_id: maxId });
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

const MEDIA_TYPES = { 1: "imagem", 2: "vídeo", 8: "carrossel" };

function pickImage(versions) {
  const candidates = versions?.candidates || [];
  if (!candidates.length) return null;
  // Menor imagem com pelo menos 480px de largura: suficiente para a análise
  // visual e bem mais barata em tokens que a versão 1080px.
  const sorted = [...candidates].sort((a, b) => a.width - b.width);
  return (sorted.find((c) => c.width >= 480) || sorted[sorted.length - 1]).url;
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
