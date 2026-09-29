import express from 'express';
import { createServer } from 'node:http';
import { ApiError, errorMessage, generate, listModels, normalizeBaseURL, registerCharacter } from './core.ts';

const app = express();
const port = Number(process.env.PORT ?? 3001);
app.use(express.json({ limit: '25mb' }));

function sendError(res: express.Response, err: unknown) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.error, detail: err.detail });
  }
  return res.status(500).json({ error: '内部错误', detail: errorMessage(err) });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'character-workshop-api' });
});

app.post('/api/characters/generate', (req, res) => {
  try {
    res.status(201).json(registerCharacter(req.body ?? {}));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/providers/models', async (req, res) => {
  const baseURL = normalizeBaseURL(req.body?.baseURL);
  const apiKey = req.body?.apiKey;
  if (!baseURL || typeof apiKey !== 'string' || !apiKey) {
    return res.status(400).json({ error: '需要合法的 baseURL 与 apiKey' });
  }
  try {
    res.json({ models: await listModels(baseURL, apiKey) });
  } catch (err) {
    sendError(res, err);
  }
});

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
  try {
    res.json(await generate({ baseURL, apiKey, model, prompt: prompt.trim(), image: refImage }));
  } catch (err) {
    sendError(res, err);
  }
});

const server = createServer(app);
server.listen(port, '0.0.0.0', () => console.log(`Character API listening on http://localhost:${port}`));
