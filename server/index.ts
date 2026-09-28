import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { generateImage, generateText, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const app = express();
const port = Number(process.env.PORT ?? 3001);
app.use(express.json({ limit: '25mb' }));

const UPSTREAM_TIMEOUT_MS = 20_000;
const GENERATE_TIMEOUT_MS = 240_000;

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'character-workshop-api' });
});

app.post('/api/characters/generate', (req, res) => {
  const { species = '鲸鱼娘', style = '铸币浮雕', mood = '神秘', variation = 42 } = req.body ?? {};
  const amount = Number(variation);
  if (![species, style, mood].every(value => typeof value === 'string') || !Number.isFinite(amount) || amount < 0 || amount > 100) {
    return res.status(400).json({ error: 'species/style/mood 必须是字符串，variation 必须在 0 到 100 之间' });
  }
  res.status(201).json({ id: randomUUID(), species, style, mood, variation: amount, createdAt: new Date().toISOString() });
});

function normalizeBaseURL(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as { statusCode?: number; responseBody?: string; data?: unknown };
    const status = anyErr.statusCode ? `HTTP ${anyErr.statusCode}` : '';
    const body = typeof anyErr.responseBody === 'string' ? anyErr.responseBody.slice(0, 300) : '';
    return [status, err.message, body].filter(Boolean).join(' · ');
  }
  return String(err).slice(0, 300);
}

/** 代理请求 OpenAI 兼容端点的 /models，避免浏览器 CORS。 */
app.post('/api/providers/models', async (req, res) => {
  const baseURL = normalizeBaseURL(req.body?.baseURL);
  const apiKey = req.body?.apiKey;
  if (!baseURL || typeof apiKey !== 'string' || !apiKey) {
    return res.status(400).json({ error: '需要合法的 baseURL 与 apiKey' });
  }
  try {
    const upstream = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 300);
      return res.status(502).json({ error: `提供方返回 HTTP ${upstream.status}`, detail });
    }
    const payload: unknown = await upstream.json();
    const list = Array.isArray(payload) ? payload : (payload as { data?: unknown[] })?.data;
    const ids = (Array.isArray(list) ? list : [])
      .map(item => (typeof item === 'string' ? item : (item as { id?: unknown })?.id))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    res.json({ models: [...new Set(ids)].sort() });
  } catch (err) {
    res.status(502).json({ error: '无法连接该 Base URL', detail: errorMessage(err) });
  }
});

type FoundImage = { base64?: string; url?: string; mediaType?: string };

const DATA_URI_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g;
const MD_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/g;
const IMAGE_URL_RE = /https?:\/\/\S+?\.(?:png|jpe?g|webp|gif|bmp)(?:\?\S*)?/gi;

function pushImage(out: FoundImage[], img: FoundImage) {
  if (!img.base64 && !img.url) return;
  const key = img.base64 ? `b64:${img.base64.slice(0, 64)}` : `url:${img.url}`;
  if (!out.some(existing => (existing.base64 ? `b64:${existing.base64.slice(0, 64)}` : `url:${existing.url}`) === key)) {
    out.push(img);
  }
}

/** 在任意 JSON 值里递归寻找图片字段（message.images、data[].b64_json、image_url 等）。 */
function collectImages(value: unknown, out: FoundImage[], depth = 0) {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    DATA_URI_RE.lastIndex = 0;
    const dataUri = DATA_URI_RE.exec(value);
    if (dataUri) pushImage(out, { url: dataUri[0].replace(/\s/g, '') });
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectImages(item, out, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, v] of Object.entries(record)) {
    if (key === 'b64_json' && typeof v === 'string' && v) {
      pushImage(out, { base64: v });
    } else if ((key === 'image_url' || key === 'imageUrl') && v) {
      if (typeof v === 'string') pushImage(out, { url: v });
      else if (typeof (v as { url?: unknown }).url === 'string') pushImage(out, { url: (v as { url: string }).url });
    } else if (key === 'url' && typeof v === 'string' && (v.startsWith('data:image/') || IMAGE_URL_RE.test(v))) {
      IMAGE_URL_RE.lastIndex = 0;
      pushImage(out, { url: v });
    } else {
      collectImages(v, out, depth + 1);
    }
  }
}

/** 在文本里找 markdown 图片 / data URI / 直链图片。 */
function collectImagesFromText(text: string, out: FoundImage[]) {
  for (const match of text.matchAll(MD_IMAGE_RE)) pushImage(out, { url: match[1] });
  for (const match of text.matchAll(DATA_URI_RE)) pushImage(out, { url: match[0].replace(/\s/g, '') });
  for (const match of text.matchAll(IMAGE_URL_RE)) pushImage(out, { url: match[0] });
}

/** 走 chat/completions：发送 text (+image) 多模态消息，从结果里挖图片。 */
async function generateViaChat(opts: {
  baseURL: string; apiKey: string; model: string; prompt: string;
  image?: { data: string; mediaType: string };
}): Promise<{ images: FoundImage[]; text: string }> {
  const provider = createOpenAICompatible({ name: 'custom', baseURL: opts.baseURL, apiKey: opts.apiKey });
  const content: Array<{ type: 'file'; data: string; mediaType: string } | { type: 'text'; text: string }> = [];
  if (opts.image) content.push({ type: 'file', data: opts.image.data, mediaType: opts.image.mediaType });
  content.push({ type: 'text', text: opts.prompt });
  const messages: ModelMessage[] = [{ role: 'user', content }];

  const result = await generateText({
    model: provider.chatModel(opts.model),
    messages,
    timeout: GENERATE_TIMEOUT_MS,
  });

  const images: FoundImage[] = [];
  for (const file of result.files) {
    if (file.mediaType?.startsWith('image/')) pushImage(images, { base64: file.base64, mediaType: file.mediaType });
  }
  for (const part of result.content) {
    if (part.type === 'file' && part.file.mediaType?.startsWith('image/')) {
      pushImage(images, { base64: part.file.base64, mediaType: part.file.mediaType });
    }
  }
  for (const step of result.steps) {
    collectImages(step.response.body, images);
  }
  if (result.text) collectImagesFromText(result.text, images);
  return { images, text: result.text ?? '' };
}

/** 走 /images/*：有参考图时打 edits（multipart），否则 generations。ai-sdk 仅认 b64_json，失败时退回手写请求兼容 url 返回。 */
async function generateViaImagesAPI(opts: {
  baseURL: string; apiKey: string; model: string; prompt: string;
  image?: { data: string; mediaType: string };
}): Promise<FoundImage[]> {
  const provider = createOpenAICompatible({ name: 'custom', baseURL: opts.baseURL, apiKey: opts.apiKey });
  try {
    const result = await generateImage({
      model: provider.imageModel(opts.model),
      prompt: opts.image
        ? { images: [opts.image.data], text: opts.prompt }
        : opts.prompt,
      abortSignal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      providerOptions: { custom: { response_format: 'b64_json' } },
    });
    return result.images.map(file => ({ base64: file.base64, mediaType: file.mediaType }));
  } catch (err) {
    // 许多兼容端点只返回 url、或不支持 multipart edits —— 退回手写请求，两种返回都收。
    return generateViaImagesRaw(opts, err);
  }
}

async function generateViaImagesRaw(opts: {
  baseURL: string; apiKey: string; model: string; prompt: string;
  image?: { data: string; mediaType: string };
}, cause: unknown): Promise<FoundImage[]> {
  const headers = { Authorization: `Bearer ${opts.apiKey}` };
  const signal = AbortSignal.timeout(GENERATE_TIMEOUT_MS);
  let upstream: Response;
  if (opts.image) {
    const form = new FormData();
    form.set('model', opts.model);
    form.set('prompt', opts.prompt);
    const bytes = Buffer.from(opts.image.data, 'base64');
    form.set('image', new Blob([bytes], { type: opts.image.mediaType }), 'reference.png');
    upstream = await fetch(`${opts.baseURL}/images/edits`, { method: 'POST', headers, body: form, signal });
  } else {
    upstream = await fetch(`${opts.baseURL}/images/generations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, prompt: opts.prompt, response_format: 'b64_json' }),
      signal,
    });
  }
  if (!upstream.ok) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 300);
    throw new Error(`图像接口 HTTP ${upstream.status}${detail ? ` · ${detail}` : ''}（SDK 调用曾报：${errorMessage(cause)}）`);
  }
  const payload = (await upstream.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
  const images: FoundImage[] = [];
  // images API 标准形状里 url 必定是图片，直接收
  for (const item of payload?.data ?? []) {
    if (item?.b64_json) pushImage(images, { base64: item.b64_json });
    else if (item?.url) pushImage(images, { url: item.url });
  }
  collectImages(payload, images);
  if (images.length === 0) throw new Error(`图像接口响应中未找到图片（SDK 调用曾报：${errorMessage(cause)}）`);
  return images;
}

/**
 * 统一图片生成入口。
 * 有参考图：先 chat（多模态消息），再 /images/edits。
 * 无参考图：先 /images/generations，再 chat。
 */
app.post('/api/generate', async (req, res) => {
  const baseURL = normalizeBaseURL(req.body?.baseURL);
  const { apiKey, model, prompt } = req.body ?? {};
  const image = req.body?.image as { data?: unknown; mediaType?: unknown } | undefined;
  if (!baseURL || typeof apiKey !== 'string' || !apiKey || typeof model !== 'string' || !model || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: '需要 baseURL、apiKey、model、prompt' });
  }
  const refImage = image && typeof image.data === 'string' && image.data
    ? { data: image.data, mediaType: typeof image.mediaType === 'string' ? image.mediaType : 'image/png' }
    : undefined;

  const attempts = refImage
    ? ([generateViaChat, generateViaImagesAPI] as const)
    : ([generateViaImagesAPI, generateViaChat] as const);

  let lastError: unknown = null;
  let chatText = '';
  for (const attempt of attempts) {
    try {
      const result = await attempt({ baseURL, apiKey, model, prompt: prompt.trim(), image: refImage });
      const images = 'images' in result ? result.images : result;
      if ('text' in result && result.text) chatText = result.text;
      if (images.length > 0) {
        return res.json({ image: images[0], images, text: chatText || undefined });
      }
    } catch (err) {
      lastError = err;
    }
  }
  res.status(502).json({
    error: '模型没有返回图片',
    detail: lastError ? errorMessage(lastError) : '已尝试所有调用路径，响应中均不含图片',
  });
});

const server = createServer(app);
server.listen(port, '0.0.0.0', () => console.log(`Character API listening on http://localhost:${port}`));
