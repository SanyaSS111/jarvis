// Hugging Face catalog: search GGUF repos and turn a repo's file tree into installable
// variants ("quants"), each with its files, sizes and SHA-256 from the LFS metadata.
'use strict';

const API = 'https://huggingface.co/api';
const cache = new Map(); // url -> {at, data}
const TTL = 30 * 60 * 1000;

async function getJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Hugging Face ответил ${res.status}`);
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}

// Repos that are GGUF but usable nowhere here (embeddings, speech, OCR…): hidden from the catalog.
const NOT_CHAT = /embed|rerank|asr|whisper|parakeet|ocr|tts|speech|audio|vocoder|locate|clip-/i;

// Image/video generators (run in ComfyUI, not llama.cpp). GGUF architectures as in ComfyUI-GGUF.
const VIDEO_ARCH = /^(wan|ltxv|hyvid|hunyuan_?video|mochi|cogvideo)/i;
const IMAGE_ARCH = /^(flux|sd1|sdxl|sd3|aura|hidream|cosmos|lumina|qwen_image|ideogram|krea|minimax|chroma|pixart|kolors|omnigen)/i;
const IMAGE_NAME = /stable-diffusion|\bsdxl\b|\bsd3|\bflux|qwen-image|hidream|chroma|z-image|lumina|pixart|kolors|omnigen/i;
const VIDEO_NAME = /wan2|hunyuan-?video|ltx-?video|ltxv|mochi|cogvideo/i;

// 'chat' (llama.cpp / the agent), 'image' or 'video' (ComfyUI).
function kindOf(repo, { tags = [], gguf = {}, pipeline = '' }) {
  const arch = gguf.architecture || '';
  if (/-to-video$/.test(pipeline) || VIDEO_ARCH.test(arch) || (tags.includes('text-to-video') || tags.includes('image-to-video'))) return 'video';
  if (/^(text-to-image|image-to-image|unconditional-image-generation)$/.test(pipeline) || IMAGE_ARCH.test(arch)
    || tags.includes('text-to-image') || tags.includes('image-generation')) return 'image';
  if (!gguf.chat_template && VIDEO_NAME.test(repo)) return 'video';
  if (!gguf.chat_template && IMAGE_NAME.test(repo)) return 'image';
  return 'chat';
}

// Filterable traits shared by search results and model details.
function traits(repo, { tags = [], gguf = {}, hasMmproj = false, pipeline = '' }) {
  const kind = kindOf(repo, { tags, gguf, pipeline });
  // HF reads metadata from one GGUF of the repo — sometimes a small MTP/projector file. If the
  // name says "27B" and the metadata says 1.9B, trust the name ("-A3B" is not matched: it is active params).
  let params = gguf.architecture !== 'clip' ? gguf.total || null : null;
  const named = repo.split('/').pop().match(/(?:^|[-_])(\d+(?:\.\d+)?)B(?=[-_.]|$)/i);
  if (named && (!params || params < Number(named[1]) * 1e9 * 0.5)) params = Number(named[1]) * 1e9;
  if (kind !== 'chat') {
    return { kind, image: true, arch: gguf.architecture || null, params, ctxMax: null, moe: false, tools: null, vision: false,
      uncensored: /uncensor|abliterat|heretic|obliterat|nsfw/i.test(repo) || tags.includes('uncensored'), coder: false };
  }
  return {
    kind, image: false,
    arch: gguf.architecture && gguf.architecture !== 'clip' ? gguf.architecture : null,
    params,
    ctxMax: gguf.context_length || null,
    moe: /moe/i.test(gguf.architecture || '') || tags.includes('moe') || /-A\d+(\.\d+)?B/i.test(repo),
    tools: typeof gguf.chat_template === 'string' && gguf.chat_template ? /\btools?\b/.test(gguf.chat_template) : null,
    vision: hasMmproj || pipeline === 'image-text-to-text',
    uncensored: /uncensor|abliterat|heretic|obliterat/i.test(repo) || tags.includes('uncensored'),
    coder: /coder|code(?!x)|devstral|starcoder/i.test(repo) || tags.includes('code'),
  };
}

// One page of GGUF repos, most downloaded first. `cursor` comes from the previous page (HF Link header).
async function search(query, cursor) {
  const q = new URLSearchParams({ filter: 'gguf', sort: 'downloads', direction: '-1', limit: '50' });
  if (query) q.set('search', query);
  if (cursor) q.set('cursor', cursor);
  // Expanded fields let the UI filter results (vision, uncensored, tools…) without a request per model.
  const expand = ['downloads', 'likes', 'tags', 'gguf', 'pipeline_tag', 'gated', 'siblings'].map((e) => `expand[]=${e}`).join('&');
  const url = `${API}/models?${q}&${expand}`;
  let page = cache.get(url);
  if (!page || Date.now() - page.at > TTL) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Hugging Face ответил ${res.status}`);
    const link = res.headers.get('link') || '';
    const m = link.match(/[?&]cursor=([^&>]+)[^>]*>;\s*rel="next"/);
    page = { at: Date.now(), data: { list: await res.json(), next: m ? decodeURIComponent(m[1]) : null } };
    cache.set(url, page);
  }
  const { list, next } = page.data;
  const items = list.filter((m) => !NOT_CHAT.test(m.id)).map((m) => ({
    repo: m.id,
    downloads: m.downloads || 0,
    likes: m.likes || 0,
    gated: !!m.gated,
    ...traits(m.id, {
      tags: m.tags || [], gguf: m.gguf || {}, pipeline: m.pipeline_tag || '',
      hasMmproj: (m.siblings || []).some((s) => /(^|\/)mmproj[^/]*\.gguf$/i.test(s.rfilename)),
    }),
  }));
  return { items, next };
}

const QUANT_RE = /[-_.]((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4(?:_MOE)?|NVFP4|TQ\d_\d))(?:-\d{5}-of-\d{5})?\.gguf$/i;

function quantKey(filePath) {
  const base = filePath.split('/').pop();
  if (/^mmproj/i.test(base) || /^mtp[-_]/i.test(base) || /(^|\/)mtp\//i.test(filePath) || /imatrix/i.test(base)) return null;
  const m = base.match(QUANT_RE);
  return m ? m[1].toUpperCase() : 'GGUF';
}

// Rough bits per weight, used for ordering and "quality" hints.
function bitsOf(key) {
  const k = key.replace(/^UD-/, '');
  if (/^(BF16|F16)$/.test(k)) return 16;
  if (k === 'F32') return 32;
  if (/FP4/.test(k)) return 4.25;
  if (/^TQ/.test(k)) return 1.7;
  const m = k.match(/^I?Q(\d)/);
  return m ? Number(m[1]) + (/_K_(L|XL)$/.test(k) ? 0.5 : 0) : 8;
}

function pickMmproj(files) {
  const mm = files.filter((f) => /^mmproj/i.test(f.path.split('/').pop()));
  const pref = [/(^|[-_.])f16/i, /bf16/i, /q8/i, /f32/i];
  for (const re of pref) { const hit = mm.find((f) => re.test(f.path)); if (hit) return hit; }
  return mm[0] || null;
}

// ComfyUI companion files of an image/video model: by folder (text_encoders/, vae/) or by name.
function companionRole(p) {
  const low = p.toLowerCase(), base = low.split('/').pop();
  if (!/\.(safetensors|gguf|sft)$/.test(base)) return null;
  if (/(^|\/)(text_encoders?|clip|te)\//.test(low) || /^(t5|umt5|clip_[lg]|qwen[\d.]*[-_]?vl|llava|gemma)[^/]*$/.test(base) || /text[-_]?encoder/.test(base)) return 'text_encoders';
  if (/(^|\/)vae\//.test(low) || /(^|[-_.])vae([-_.]|$)/.test(base) || /^ae\.(safetensors|sft)$/.test(base)) return 'vae';
  return null;
}
// The lightest file per role (int8/fp8 encoders instead of bf16: same pictures, half the memory).
function pickCompanions(files) {
  const out = {};
  for (const f of files) {
    const role = companionRole(f.path);
    if (role && (!out[role] || f.size < out[role].size)) out[role] = f;
  }
  return out;
}

function titleOf(repo) {
  return repo.split('/').pop().replace(/[-_]GGUF$/i, '').replace(/[-_]gguf$/i, '');
}

async function details(repo) {
  const [info, tree] = await Promise.all([
    getJson(`${API}/models/${repo}`),
    getJson(`${API}/models/${repo}/tree/main?recursive=true`).catch(() => []),
  ]);
  const all = tree.filter((f) => f.type === 'file')
    .map((f) => ({ path: f.path, size: (f.lfs && f.lfs.size) || f.size || 0, sha: (f.lfs && f.lfs.oid) || null }));
  const t = traits(repo, { tags: info.tags || [], gguf: info.gguf || {}, pipeline: info.pipeline_tag || '' });
  // Image models: text encoders / VAE in the repo are companions, not variants of the model itself.
  const companions = t.kind === 'chat' ? null : pickCompanions(all);
  const files = all.filter((f) => /\.gguf$/i.test(f.path) && !(companions && companionRole(f.path)));
  // One variant = one file, or the parts of one split file (…-00001-of-00003.gguf).
  const groups = new Map();
  for (const f of files) {
    const key = quantKey(f.path);
    if (!key) continue;
    const stem = f.path.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, '');
    const g = groups.get(stem) || { key, stem, files: [], bytes: 0 };
    g.files.push(f); g.bytes += f.size;
    groups.set(stem, g);
  }
  // Two files with the same quant type (e.g. Q4_0 and QAD-Q4_0): name them by what differs.
  const byKey = new Map();
  for (const g of groups.values()) byKey.set(g.key, (byKey.get(g.key) || 0) + 1);
  const title = titleOf(repo).toLowerCase();
  for (const g of groups.values()) {
    if (byKey.get(g.key) < 2) continue;
    let base = g.stem.split('/').pop().replace(/\.gguf$/i, '');
    if (base.toLowerCase().startsWith(title)) base = base.slice(title.length).replace(/^[-_.]+/, '');
    g.key = (base || g.key).toUpperCase();
  }
  const quants = [...groups.values()]
    .map((g) => ({ ...g, files: g.files.sort((a, b) => a.path.localeCompare(b.path)), bits: bitsOf(g.key) }))
    .sort((a, b) => a.bytes - b.bytes);
  const mmproj = pickMmproj(files);
  return {
    repo,
    title: titleOf(repo),
    author: info.author || repo.split('/')[0],
    downloads: info.downloads || 0,
    likes: info.likes || 0,
    gated: !!info.gated,
    license: (info.cardData && info.cardData.license) || null,
    ...traits(repo, { tags: info.tags || [], gguf: info.gguf || {}, hasMmproj: !!mmproj, pipeline: info.pipeline_tag || '' }),
    ...(t.kind === 'chat'
      ? { vision: !!mmproj, mmproj } // details know the files: vision only if there is a projector to download
      : { mmproj: null, companions }),
    quants,
  };
}

module.exports = { search, details, bitsOf };
