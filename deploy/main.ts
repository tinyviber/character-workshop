/**
 * Deno Deploy 入口：/api/* 走与 Express 相同的 core.ts 逻辑，其余路径回退到
 * `vite build` 产物（dist/）的静态文件服务，未知路径回退 index.html（SPA）。
 *
 * 本地验证：deno install && deno task build && deno task start
 * 部署：Deno Deploy → New App → 本仓库 → Dynamic，Entrypoint = deploy/main.ts，
 *       Build command = deno task build
 */
import { serveDir, serveFile } from 'jsr:@std/http/file-server';
import { ApiError, errorMessage, generate, listModels, normalizeBaseURL, registerCharacter } from '../server/core.ts';

const json = (data: unknown, status = 200) => Response.json(data, { status });

const MAX_BODY_BYTES = 25 * 1024 * 1024;

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, '请求体超过 25MB 上限');
  try {
    const body: unknown = await req.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const PRIVATE_IPV4_RE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;
const PRIVATE_IPV6_RE = /^(::1|fe80:|f[cd])/i;
const LOCAL_HOST_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|home\.arpa)$/i;

/** 公开部署时只允许指向公网 host —— 部署实例够不到用户 LAN，私网地址只会打到平台内网。 */
function publicBaseURL(raw: unknown): string | null {
  const baseURL = normalizeBaseURL(raw);
  if (!baseURL) return null;
  const host = new URL(baseURL).hostname.replace(/^\[|\]$/g, '');
  if (LOCAL_HOST_RE.test(host) || PRIVATE_IPV4_RE.test(host) || PRIVATE_IPV6_RE.test(host)) return null;
  return baseURL;
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json({ ok: true, service: 'character-workshop-api' });
    }
    if (req.method === 'POST' && url.pathname === '/api/characters/generate') {
      return json(registerCharacter(await readBody(req)), 201);
    }
    if (req.method === 'POST' && url.pathname === '/api/providers/models') {
      const body = await readBody(req);
      const baseURL = publicBaseURL(body.baseURL);
      if (!baseURL || typeof body.apiKey !== 'string' || !body.apiKey) {
        return json({ error: '需要合法的公网 baseURL 与 apiKey' }, 400);
      }
      return json({ models: await listModels(baseURL, body.apiKey) });
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const body = await readBody(req);
      const baseURL = publicBaseURL(body.baseURL);
      const { apiKey, model, prompt } = body as { apiKey?: unknown; model?: unknown; prompt?: unknown };
      const image = body.image as { data?: unknown; mediaType?: unknown } | undefined;
      if (
        !baseURL || typeof apiKey !== 'string' || !apiKey ||
        typeof model !== 'string' || !model ||
        typeof prompt !== 'string' || !prompt.trim()
      ) {
        return json({ error: '需要合法的公网 baseURL、apiKey、model、prompt' }, 400);
      }
      const refImage = image && typeof image.data === 'string' && image.data
        ? { data: image.data, mediaType: typeof image.mediaType === 'string' ? image.mediaType : 'image/png' }
        : undefined;
      return json(await generate({ baseURL, apiKey, model, prompt: prompt.trim(), image: refImage }));
    }
    return json({ error: 'Not Found' }, 404);
  } catch (err) {
    if (err instanceof ApiError) {
      return json({ error: err.error, detail: err.detail }, err.status);
    }
    return json({ error: '内部错误', detail: errorMessage(err) }, 500);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return handleApi(req, url);
  const res = await serveDir(req, { fsRoot: 'dist' });
  // SPA fallback 只服务导航请求 —— 缺失的 JS/CSS 等资源必须返回真正的 404
  if (res.status === 404 && req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html')) {
    return serveFile(req, 'dist/index.html');
  }
  return res;
});
