import { generateImage, generateText, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const UPSTREAM_TIMEOUT_MS = 20_000;
export const GENERATE_TIMEOUT_MS = 240_000;

/** 带 HTTP 状态的业务错误，Express / Deno 两个入口各自序列化。 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public error: string,
    public detail?: string,
  ) {
    super(error);
  }
}

export function normalizeBaseURL(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as { statusCode?: number; responseBody?: string; data?: unknown };
    const status = anyErr.statusCode ? `HTTP ${anyErr.statusCode}` : '';
    const body = typeof anyErr.responseBody === 'string' ? anyErr.responseBody.slice(0, 300) : '';
    return [status, err.message, body].filter(Boolean).join(' · ');
  }
  return String(err).slice(0, 300);
}

/** POST /api/characters/generate：校验并回显角色参数。 */
export function registerCharacter(body: Record<string, unknown>) {
  const { species = '鲸鱼娘', style = '铸币浮雕', mood = '神秘', variation = 42 } = body;
  const amount = Number(variation);
  if (
    ![species, style, mood].every(value => typeof value === 'string') ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    amount > 100
  ) {
    throw new ApiError(400, 'species/style/mood 必须是字符串，variation 必须在 0 到 100 之间');
  }
  return {
    id: crypto.randomUUID(),
    species,
    style,
    mood,
    variation: amount,
    createdAt: new Date().toISOString(),
  };
}

/** POST /api/providers/models：代理请求 OpenAI 兼容端点的 /models，避免浏览器 CORS。 */
export async function listModels(baseURL: string, apiKey: string): Promise<string[]> {
  try {
    const upstream = await fetch(`${baseURL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 300);
      throw new ApiError(502, `提供方返回 HTTP ${upstream.status}`, detail);
    }
    const payload: unknown = await upstream.json();
    const list = Array.isArray(payload) ? payload : (payload as { data?: unknown[] })?.data;
    const ids = (Array.isArray(list) ? list : [])
      .map(item => (typeof item === 'string' ? item : (item as { id?: unknown })?.id))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)].sort();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, '无法连接该 Base URL', errorMessage(err));
  }
}

export type FoundImage = { base64?: string; url?: string; mediaType?: string };

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

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const u8 = Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array };
  if (typeof u8.fromBase64 === 'function') return new Uint8Array(u8.fromBase64(b64));
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
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
    return result.images.map((file: { base64: string; mediaType: string }) => ({ base64: file.base64, mediaType: file.mediaType }));
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
    form.set('image', new Blob([base64ToBytes(opts.image.data)], { type: opts.image.mediaType }), 'reference.png');
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

export interface GenerateOpts {
  baseURL: string;
  apiKey: string;
  model: string;
  prompt: string;
  image?: { data: string; mediaType: string };
}

export interface GenerateOutput {
  image: FoundImage;
  images: FoundImage[];
  text?: string;
}

/**
 * 统一图片生成入口。
 * 有参考图：先 chat（多模态消息），再 /images/edits。
 * 无参考图：先 /images/generations，再 chat。
 */
export async function generate(opts: GenerateOpts): Promise<GenerateOutput> {
  const attempts = opts.image
    ? ([generateViaChat, generateViaImagesAPI] as const)
    : ([generateViaImagesAPI, generateViaChat] as const);

  let lastError: unknown = null;
  let chatText = '';
  for (const attempt of attempts) {
    try {
      const result = await attempt({ baseURL: opts.baseURL, apiKey: opts.apiKey, model: opts.model, prompt: opts.prompt, image: opts.image });
      const images = 'images' in result ? result.images : result;
      if ('text' in result && result.text) chatText = result.text;
      if (images.length > 0) {
        return { image: images[0], images, text: chatText || undefined };
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw new ApiError(
    502,
    '模型没有返回图片',
    lastError ? errorMessage(lastError) : '已尝试所有调用路径，响应中均不含图片',
  );
}
