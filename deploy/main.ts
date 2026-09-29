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

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
      const baseURL = normalizeBaseURL(body.baseURL);
      if (!baseURL || typeof body.apiKey !== 'string' || !body.apiKey) {
        return json({ error: '需要合法的 baseURL 与 apiKey' }, 400);
      }
      return json({ models: await listModels(baseURL, body.apiKey) });
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const body = await readBody(req);
      const baseURL = normalizeBaseURL(body.baseURL);
      const { apiKey, model, prompt } = body as { apiKey?: unknown; model?: unknown; prompt?: unknown };
      const image = body.image as { data?: unknown; mediaType?: unknown } | undefined;
      if (
        !baseURL || typeof apiKey !== 'string' || !apiKey ||
        typeof model !== 'string' || !model ||
        typeof prompt !== 'string' || !prompt.trim()
      ) {
        return json({ error: '需要 baseURL、apiKey、model、prompt' }, 400);
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
  if (res.status === 404) return serveFile(req, 'dist/index.html');
  return res;
});
