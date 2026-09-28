import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const app = express();
const port = Number(process.env.PORT ?? 3001);
app.use(express.json({ limit: '32kb' }));

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

const server = createServer(app);
server.listen(port, '0.0.0.0', () => console.log(`Character API listening on http://localhost:${port}`));
