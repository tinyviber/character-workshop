import './style.css';
import {
  loadProviders,
  saveProviders,
  loadPrefs,
  savePrefs,
  type SavedProvider,
} from './store';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

/* ---------- 程序化占位图（未配置模型时的回退预览） ---------- */

const palettes: string[][] = [
  ['#6c9e99', '#dfb66d', '#f1d9b6'],
  ['#7186bd', '#e68b7d', '#f7d6a2'],
  ['#809b66', '#d4a253', '#eee1c7'],
  ['#a4789e', '#ddb36e', '#f2d9c1'],
  ['#57929e', '#db805d', '#e9d3a9'],
];
let seed = 42;

function art(): string {
  const p = palettes[seed % palettes.length];
  const v = +$<HTMLInputElement>('#variation').value;
  const j = v / 100;
  const eye = 2.5 + j * 3.5;
  const fin = 15 + j * 14;
  const orn = 7 + j * 8;
  const hair = 69 - Math.round(j * 10);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 320" width="250" height="308"><defs><linearGradient id="body" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${p[0]}"/><stop offset="1" stop-color="${p[0]}" stop-opacity=".72"/></linearGradient><linearGradient id="gold" x2="0" y2="1"><stop stop-color="#f5dc9c"/><stop offset="1" stop-color="${p[1]}"/></linearGradient></defs><ellipse cx="130" cy="292" rx="76" ry="12" fill="#a68c6840"/><path d="M70 108 Q${42 - fin / 2} ${65 - fin / 2} 68 47 Q89 76 106 81 M190 108 Q${218 + fin / 2} ${65 - fin / 2} 192 47 Q171 76 154 81" fill="url(#body)" stroke="#315d62" stroke-width="4"/><path d="M83 111 Q130 69 177 111 L188 205 Q181 259 130 278 Q79 259 72 205Z" fill="url(#body)" stroke="#315d62" stroke-width="4"/><path d="M82 210 Q130 190 178 210 L185 235 Q130 266 75 235Z" fill="url(#gold)" stroke="#9e7542" stroke-width="3"/><path d="M79 131 Q45 124 43 146 Q64 157 83 151 M181 131 Q215 124 217 146 Q196 157 177 151" fill="${p[0]}" stroke="#315d62" stroke-width="4"/><path d="M105 161 Q115 151 124 162 M136 162 Q145 151 155 161" fill="none" stroke="#263b43" stroke-width="4" stroke-linecap="round"/><path d="M117 179 Q130 190 143 179" fill="none" stroke="#a95f57" stroke-width="3" stroke-linecap="round"/><circle cx="130" cy="111" r="38" fill="${p[2]}" stroke="#9b754b" stroke-width="3"/><path d="M94 105 Q96 ${65 - j * 10} 130 ${hair} Q164 ${65 - j * 10} 166 105 Q152 88 130 91 Q108 88 94 105" fill="#344b58"/><path d="M107 120 Q116 129 124 120 M136 120 Q144 129 153 120" fill="none" stroke="#344b58" stroke-width="3" stroke-linecap="round"/><circle cx="114" cy="116" r="${eye}" fill="#263b43"/><circle cx="146" cy="116" r="${eye}" fill="#263b43"/><path d="M166 85 Q190 71 190 91 Q188 103 173 105" fill="url(#gold)" stroke="#946e41" stroke-width="3"/><circle cx="181" cy="91" r="${orn}" fill="#dbe8df" stroke="#946e41" stroke-width="2"/></svg>`;
}

/* ---------- 全局状态 ---------- */

interface RefImage {
  dataUrl: string;
  data: string; // base64 payload
  mediaType: string;
}
interface Generated {
  src: string; // data: 或 http(s) URL
  viaModel?: string;
  slotId?: number; // 关联的历史槽位，用于高亮选中态
}

let providers: SavedProvider[] = [];
let refImage: RefImage | null = null;
let generated: Generated | null = null; // 当前展示/选中的图（= 某个 done 槽位）
let generating = false;

/** 生成历史槽位：pending → done/failed。仅驻内存，不写 localStorage。 */
interface Slot {
  id: number;
  state: 'pending' | 'done' | 'failed';
  src?: string;
  prompt: string;
  model: string;
}
const SLOT_CAP = 12;
let slots: Slot[] = [];
let slotSeq = 0;

/* ---------- 通用 ---------- */

function toast(text: string) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

function activeChip(kind: string): string {
  return $(`[data-kind="${kind}"] .chip.active`).textContent ?? '';
}

function renderMeta() {
  $('#previewName').textContent = ($('#name') as HTMLInputElement).value || '未命名角色';
  $('#styleTag').textContent = activeChip('style');
  $('#moodTag').textContent = activeChip('mood');
  $('#variationLabel').textContent = ($('#variation') as HTMLInputElement).value + '%';
  const key = styleKey();
  $('#stage').className =
    'stage ' + (key === 'coin' ? 'coin' : key === 'pixel' ? 'pixel' : 'watercolor');
  $('#seed').textContent = generated?.viaModel ?? 'SEED ' + String(seed).padStart(3, '0');
  $('#previewSub').textContent = generated ? '模型生成结果　·　可继续调整' : '角色概念预览　·　可继续调整';
  $('#notice').textContent = providers.length
    ? '已连接提供方；生成调用所选模型。'
    : '当前为本地程序化预览；点右上角「提供方」接入模型。';
}

function renderStage() {
  const img = $<HTMLImageElement>('#generatedImg');
  if (generated) {
    img.src = generated.src;
    img.hidden = false;
    $('#character').hidden = true;
  } else {
    img.hidden = true;
    $('#character').hidden = false;
    $('#character').innerHTML = art();
  }
}

function render() {
  renderMeta();
  renderStage();
}

/* ---------- 模型选择 ---------- */

function modelValue(p: SavedProvider, model: string): string {
  return `${p.id}::${model}`;
}

function renderModelSelect() {
  const sel = $<HTMLSelectElement>('#modelSelect');
  const prev = loadPrefs().selected;
  sel.innerHTML = '';
  if (providers.length === 0 || providers.every(p => p.models.length === 0)) {
    const opt = document.createElement('option');
    opt.textContent = '未配置提供方 — 点右上角 ⚙ 添加';
    opt.disabled = true;
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const p of providers) {
    const group = document.createElement('optgroup');
    group.label = p.name || p.baseURL;
    for (const m of p.models) {
      const opt = document.createElement('option');
      opt.value = modelValue(p, m);
      opt.textContent = m;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }
  if (prev && providers.some(p => p.id === prev.providerId && p.models.includes(prev.model))) {
    sel.value = modelValue(providers.find(p => p.id === prev.providerId)!, prev.model);
  }
}

function currentSelection(): { provider: SavedProvider; model: string } | null {
  const sel = $<HTMLSelectElement>('#modelSelect');
  const [providerId, ...rest] = (sel.value ?? '').split('::');
  const model = rest.join('::');
  const provider = providers.find(p => p.id === providerId && p.models.includes(model));
  return provider ? { provider, model } : null;
}

/* ---------- 提示词 ---------- */

/**
 * 风格注册表：chip 的 data-key → prompt 片段。
 * requirement 非空时覆盖默认构图要求（如铸币要大头照而非全身立绘）。
 */
interface StyleSpec {
  prompt: string;
  requirement?: string;
}
const STYLE_PROMPTS: Record<string, StyleSpec> = {
  coin: {
    prompt:
      '画风：Q版二次元萌系铸币大头插画，仅保留大头照构图并保留角色原本特色；大而透亮的双瞳（带高光渐变），脸颊淡粉腮红，圆润Q版脸型；柔和平涂色彩加细腻阴影过渡，线条干净流畅，色彩清新通透，整体可爱治愈的日系风格',
    requirement: '圆形头像/徽章式构图，仅保留头部特写，不要全身像，不要遮挡面部',
  },
  pixel: {
    prompt: '画风：复古像素艺术（pixel art），清晰像素颗粒，有限调色板，轮廓分明',
  },
  watercolor: {
    prompt: '画风：儿童绘本水彩插画，手绘质感，柔和晕染，温暖通透的色彩，可见纸张纹理',
  },
  clay: {
    prompt:
      '画风：3D 黏土盲盒玩具渲染（clay render, blind box toy），chibi 比例，柔光摄影棚光照，哑光材质，圆润造型，精致可爱',
  },
  ink: {
    prompt: '画风：中国水墨工笔，宣纸质感，墨色浓淡晕染，留白构图，清雅配色',
  },
  sticker: {
    prompt: '画风：美式卡通贴纸，粗描边高饱和配色，die-cut 白边轮廓，表情夸张生动',
  },
};

function styleKey(): string {
  return $<HTMLElement>('[data-kind="style"] .chip.active').dataset.key ?? '';
}

function buildPrompt(): string {
  const name = ($('#name') as HTMLInputElement).value || '未命名角色';
  const species = activeChip('species');
  const style = activeChip('style');
  const mood = activeChip('mood');
  const variation = ($('#variation') as HTMLInputElement).value;
  const extra = ($('#refText') as HTMLTextAreaElement).value.trim();
  const spec = STYLE_PROMPTS[styleKey()];
  const stylePart = spec?.prompt ?? `视觉风格：${style}`;
  const requirement = spec?.requirement ?? '完整角色立绘/概念设定图，居中构图';
  const traits = `角色名：「${name}」；原型：${species}；${stylePart}；气质：${mood}；变化幅度：${variation}%（数值越大设计越夸张）。`;
  const tail = `${extra ? `补充要求：${extra}。` : ''}要求：${requirement}，干净简洁的背景，画面中不要出现文字或水印。`;
  if (refImage) {
    return `参考这张图片，生成一张角色概念设计图，保持可辨识的角色特征并按以下设定重绘。${traits}${tail}`;
  }
  return `生成一张原创角色概念设计图。${traits}${tail}`;
}

/* ---------- 生成 ---------- */

function setBusy(busy: boolean) {
  generating = busy;
  ($('#generate') as HTMLButtonElement).disabled = busy;
  ($('#shuffle') as HTMLButtonElement).disabled = busy;
  $<HTMLSelectElement>('#batchCount').disabled = busy;
  $('#spinner').hidden = !busy;
}

/** 单次调用 /api/generate，消费响应里的全部图片（可能一次返回多张）。 */
async function runGenerate(
  sel: { provider: SavedProvider; model: string },
  prompt: string,
): Promise<string[]> {
  const body: Record<string, unknown> = {
    baseURL: sel.provider.baseURL,
    apiKey: sel.provider.apiKey,
    model: sel.model,
    prompt,
  };
  if (refImage) body.image = { data: refImage.data, mediaType: refImage.mediaType };
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as { error?: string; detail?: string }).detail;
    const err = (data as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(detail ? `${err}：${detail}` : err);
  }
  type Img = { base64?: string; url?: string; mediaType?: string };
  const raw = (data as { images?: Img[]; image?: Img });
  const list = Array.isArray(raw.images) && raw.images.length ? raw.images : raw.image ? [raw.image] : [];
  const srcs = list
    .map(img => (img.base64 ? `data:${img.mediaType ?? 'image/png'};base64,${img.base64}` : img.url))
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (!srcs.length) throw new Error('响应中没有图片');
  return srcs;
}

function renderSlots() {
  const strip = $('#historyStrip');
  strip.innerHTML = '';
  for (const s of slots) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'hist-item';
    if (s.state === 'pending') {
      item.disabled = true;
      const spin = document.createElement('span');
      spin.className = 'hist-spin';
      item.appendChild(spin);
      item.title = '生成中…';
    } else if (s.state === 'failed') {
      item.disabled = true;
      item.textContent = '✕';
      item.title = '生成失败';
    } else {
      if (generated && generated.slotId === s.id) item.classList.add('active');
      const img = document.createElement('img');
      img.src = s.src!;
      img.alt = '生成候选';
      img.title = s.model;
      item.appendChild(img);
      item.onclick = () => {
        generated = { src: s.src!, viaModel: s.model, slotId: s.id };
        render();
        renderSlots();
      };
    }
    strip.appendChild(item);
  }
  $('#historyWrap').hidden = slots.length === 0;
}

/** 把一次响应的图片按序填入 pending 槽位；多出的图追加为新槽位。返回消费掉的图片数。 */
function fillSlots(pendings: Slot[], srcs: string[]): number {
  let i = 0;
  for (const s of pendings) {
    if (s.state === 'pending' && i < srcs.length) {
      s.state = 'done';
      s.src = srcs[i];
      i++;
    }
  }
  for (; i < srcs.length; i++) {
    const last = pendings[pendings.length - 1];
    slots.unshift({ id: slotSeq++, state: 'done', src: srcs[i], prompt: last.prompt, model: last.model });
  }
  // 容量裁剪：pending 保留，done/failed 只留最近 SLOT_CAP 个
  const rest = slots.filter(s => s.state !== 'pending').slice(0, SLOT_CAP);
  slots = [...slots.filter(s => s.state === 'pending'), ...rest];
  renderSlots();
  return i;
}

async function generate() {
  if (generating) return;
  const sel = currentSelection();
  if (!sel) {
    // 未配置提供方：退回程序化占位图
    seed++;
    generated = null;
    render();
    toast('未配置模型，已生成本地占位图 — 可在「提供方」中接入真实模型');
    return;
  }
  setBusy(true);
  const want = Math.max(1, Math.min(4, Number($<HTMLSelectElement>('#batchCount').value) || 1));
  const prompt = buildPrompt(); // 派发时冻结，避免生成中改 chip 导致串味
  const batch: Slot[] = Array.from({ length: want }, () => ({
    id: slotSeq++,
    state: 'pending',
    prompt,
    model: sel.model,
  }));
  slots = [...batch, ...slots];
  renderSlots();
  let firstError: unknown = null;
  let made = 0; // 实际产出的图片数（含单次响应多出的图）
  try {
    // 首发可能一次返回多张；失败不急着判死刑，剩余槽位照常补发
    made += fillSlots(batch, await runGenerate(sel, prompt));
  } catch (err) {
    firstError = err;
  }
  const rest = batch.filter(s => s.state === 'pending');
  if (rest.length) {
    await Promise.allSettled(
      rest.map(async s => {
        try {
          made += fillSlots([s], await runGenerate(sel, prompt));
        } catch (err) {
          s.state = 'failed';
          firstError ??= err;
          renderSlots();
        }
      }),
    );
  }
  const done = batch.filter(s => s.state === 'done');
  const failed = batch.filter(s => s.state === 'failed').length;
  if (done.length) {
    generated = { src: done[0].src!, viaModel: sel.model, slotId: done[0].id };
    toast(failed ? `生成完成 ${made} 张，${failed} 张失败` : `生成完成，共 ${made} 张`);
  } else {
    const reason = firstError instanceof Error ? firstError.message : firstError ? String(firstError) : '模型没有返回图片';
    toast(`生成失败：${reason}`.slice(0, 120));
  }
  renderSlots();
  render();
  setBusy(false);
}

/* ---------- 参考图片：上传 / 拖拽 / 粘贴 ---------- */

function setRefImage(file: Blob, name = 'pasted.png') {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result);
    const mediaType = file.type || 'image/png';
    refImage = { dataUrl, data: dataUrl.split(',')[1] ?? '', mediaType };
    $<HTMLImageElement>('#refImg').src = dataUrl;
    $('#refThumb').hidden = false;
    $('#dropzone').hidden = true;
    toast(`已读取参考图片${name ? `：${name}` : ''}`);
  };
  reader.readAsDataURL(file);
}

function clearRefImage() {
  refImage = null;
  $('#refThumb').hidden = true;
  $('#dropzone').hidden = false;
  ($('#fileInput') as HTMLInputElement).value = '';
}

function wireRefImage() {
  const dz = $('#dropzone');
  const input = $<HTMLInputElement>('#fileInput');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') input.click();
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) setRefImage(file, file.name);
  });
  $('#refRemove').addEventListener('click', clearRefImage);
  dz.addEventListener('dragover', e => {
    e.preventDefault();
    dz.classList.add('drag');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag');
    const file = [...(e.dataTransfer?.files ?? [])].find(f => f.type.startsWith('image/'));
    if (file) setRefImage(file, file.name);
  });
  // Cmd/Ctrl+V 粘贴剪贴板图片（光标在输入框时也不抢文本粘贴）
  document.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItem = [...items].find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    setRefImage(file, 'clipboard.png');
  });
}

/* ---------- 提供方弹窗 ---------- */

let editingId: string | null = null;
let fetchedModels: string[] = [];

function openModal() {
  $('#providerModal').hidden = false;
  renderProviderList();
  resetProviderForm();
}

function closeModal() {
  $('#providerModal').hidden = true;
}

function renderProviderList() {
  const list = $('#providerList');
  list.innerHTML = '';
  $('#providerEmpty').hidden = providers.length > 0;
  for (const p of providers) {
    const item = document.createElement('div');
    item.className = 'provider-item';
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'pi-name';
    name.textContent = p.name || 'OpenAI Compatible';
    const meta = document.createElement('div');
    meta.className = 'pi-meta';
    meta.textContent = `${p.baseURL} · ${p.models.length} 个模型`;
    info.append(name, meta);
    const ops = document.createElement('div');
    ops.className = 'pi-ops';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.textContent = '编辑';
    edit.onclick = () => startEdit(p);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '删除';
    del.className = 'danger';
    del.onclick = async () => {
      providers = providers.filter(x => x.id !== p.id);
      await saveProviders(providers);
      renderProviderList();
      renderModelSelect();
      renderMeta();
      toast('已删除提供方');
    };
    ops.append(edit, del);
    item.append(info, ops);
    list.appendChild(item);
  }
}

function resetProviderForm() {
  editingId = null;
  fetchedModels = [];
  $('#providerFormTitle').textContent = '添加 Provider';
  $<HTMLInputElement>('#pfName').value = '';
  $<HTMLInputElement>('#pfBase').value = '';
  $<HTMLInputElement>('#pfKey').value = '';
  $('#pfStatus').textContent = '';
  $('#pfStatus').classList.remove('err');
  $('#pfModels').hidden = true;
  $('#pfModelList').innerHTML = '';
  $('#pfCancel').hidden = true;
}

function startEdit(p: SavedProvider) {
  editingId = p.id;
  $('#providerFormTitle').textContent = '编辑 Provider';
  $<HTMLInputElement>('#pfName').value = p.name;
  $<HTMLInputElement>('#pfBase').value = p.baseURL;
  $<HTMLInputElement>('#pfKey').value = p.apiKey;
  fetchedModels = [...p.models];
  renderModelChecklist(p.models);
  $('#pfCancel').hidden = false;
}

function renderModelChecklist(checked: string[]) {
  const wrap = $('#pfModelList');
  wrap.innerHTML = '';
  const checkedSet = new Set(checked);
  for (const id of fetchedModels) {
    const label = document.createElement('label');
    label.className = 'pf-model';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = id;
    box.checked = checkedSet.has(id);
    const span = document.createElement('span');
    span.textContent = id;
    label.append(box, span);
    wrap.appendChild(label);
  }
  updateModelCount();
}

function checkedModels(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>('#pfModelList input:checked')].map(b => b.value);
}

function updateModelCount() {
  const total = fetchedModels.length;
  const checked = checkedModels().length;
  $('#pfModelsCount').textContent = `已选 ${checked} / ${total} 个模型`;
}

async function fetchModels() {
  const baseURL = $<HTMLInputElement>('#pfBase').value.trim();
  const apiKey = $<HTMLInputElement>('#pfKey').value.trim();
  const status = $('#pfStatus');
  status.classList.remove('err');
  if (!baseURL || !apiKey) {
    status.textContent = '先填 Base URL 和 API Key';
    status.classList.add('err');
    return;
  }
  const btn = $<HTMLButtonElement>('#pfFetch');
  btn.disabled = true;
  status.textContent = '检测中…';
  try {
    const res = await fetch('/api/providers/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL, apiKey }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const d = data as { error?: string; detail?: string };
      throw new Error(d.detail ? `${d.error}：${d.detail}` : d.error ?? `HTTP ${res.status}`);
    }
    fetchedModels = (data as { models: string[] }).models;
    if (fetchedModels.length === 0) {
      status.textContent = '端点返回了空模型列表';
      status.classList.add('err');
      $('#pfModels').hidden = true;
      return;
    }
    // 编辑时保留已勾选；新增默认全不选，交给用户挑
    const prechecked = editingId
      ? providers.find(p => p.id === editingId)?.models ?? []
      : [];
    $('#pfModels').hidden = false;
    renderModelChecklist(prechecked);
    status.textContent = `检测到 ${fetchedModels.length} 个模型`;
  } catch (err) {
    status.textContent = err instanceof Error ? err.message.slice(0, 90) : String(err);
    status.classList.add('err');
  } finally {
    btn.disabled = false;
  }
}

async function submitProvider(e: Event) {
  e.preventDefault();
  const name = $<HTMLInputElement>('#pfName').value.trim();
  const baseURL = $<HTMLInputElement>('#pfBase').value.trim();
  const apiKey = $<HTMLInputElement>('#pfKey').value.trim();
  const models = checkedModels();
  if (!/^https?:\/\//.test(baseURL)) {
    toast('Base URL 需要以 http(s):// 开头');
    return;
  }
  if (!apiKey) {
    toast('需要 API Key');
    return;
  }
  if (models.length === 0) {
    toast('先「获取模型」并勾选至少一个模型');
    return;
  }
  if (editingId) {
    const target = providers.find(p => p.id === editingId);
    if (target) Object.assign(target, { name, baseURL, apiKey, models });
  } else {
    providers.push({
      id: crypto.randomUUID(),
      name,
      baseURL,
      apiKey,
      models,
      createdAt: Date.now(),
    });
  }
  await saveProviders(providers);
  renderProviderList();
  renderModelSelect();
  renderMeta();
  resetProviderForm();
  toast(editingId ? '已更新提供方' : '已保存提供方（本地加密存储）');
}

function wireProviderModal() {
  $('#openProviders').addEventListener('click', openModal);
  $('#closeProviders').addEventListener('click', closeModal);
  $('#providerModal').addEventListener('click', e => {
    if (e.target === $('#providerModal')) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#providerModal').hidden) closeModal();
  });
  $('#pfToggleKey').addEventListener('click', () => {
    const input = $<HTMLInputElement>('#pfKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  $('#pfFetch').addEventListener('click', fetchModels);
  $('#pfAll').addEventListener('click', () => {
    document.querySelectorAll<HTMLInputElement>('#pfModelList input').forEach(b => (b.checked = true));
    updateModelCount();
  });
  $('#pfNone').addEventListener('click', () => {
    document.querySelectorAll<HTMLInputElement>('#pfModelList input').forEach(b => (b.checked = false));
    updateModelCount();
  });
  $('#pfModelList').addEventListener('change', updateModelCount);
  $('#providerForm').addEventListener('submit', submitProvider);
  $('#pfCancel').addEventListener('click', resetProviderForm);
}

/* ---------- 设为参考图（教程两步流水线/精修的手动入口） ---------- */

$('#useAsRef').addEventListener('click', async () => {
  if (!generated?.src) {
    toast('先生成或选中一张图');
    return;
  }
  try {
    // src 可能是会过期/有防盗链的远程 URL，统一转成 dataURL Blob 再入参考图
    const blob = await (await fetch(generated.src)).blob();
    setRefImage(blob, '生成图.png');
  } catch {
    toast('无法读取该图片（可能已过期或跨域受限）');
  }
});

/* ---------- 导出 ---------- */

$('#export').addEventListener('click', async () => {
  const name = ($('#name') as HTMLInputElement).value || 'character';
  if (generated) {
    try {
      let href = generated.src;
      if (!href.startsWith('data:')) {
        const blob = await (await fetch(href)).blob();
        href = URL.createObjectURL(blob);
      }
      const a = document.createElement('a');
      a.href = href;
      a.download = `${name}.png`;
      a.click();
      if (href.startsWith('blob:')) URL.revokeObjectURL(href);
      toast('图片已导出');
      return;
    } catch {
      window.open(generated.src, '_blank');
      return;
    }
  }
  const svg = $('#character svg')?.outerHTML;
  if (!svg) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  a.download = `${name}.svg`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('SVG 已导出');
});

/* ---------- 事件绑定 & 启动 ---------- */

document.querySelectorAll('.choices').forEach(group => {
  group.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains('chip')) return;
    group.querySelectorAll('.chip').forEach(b => b.classList.remove('active'));
    target.classList.add('active');
    if ((group as HTMLElement).dataset.kind === 'species') {
      const suffix = target.textContent ?? '';
      ($('#name') as HTMLInputElement).value =
        suffix === '鲸鱼娘'
          ? '深海先知 · 鲸鱼娘'
          : suffix === '小恶魔'
            ? '熔岩信使 · 小恶魔'
            : suffix === '森林精灵'
              ? '苔径旅人 · 森林精灵'
              : '齿轮守望 · 机械兽';
    }
    renderMeta();
    if (!generated) renderStage();
  });
});

$('#name').addEventListener('input', renderMeta);
$('#variation').addEventListener('input', () => {
  renderMeta();
  if (!generated) renderStage();
});
$('#modelSelect').addEventListener('change', () => {
  const sel = currentSelection();
  savePrefs(sel ? { selected: { providerId: sel.provider.id, model: sel.model } } : {});
});

$('#generate').addEventListener('click', () => void generate());
$('#shuffle').addEventListener('click', () => {
  seed = Math.floor(Math.random() * 999) + 1;
  document.querySelectorAll('.choices').forEach(g => {
    const chips = [...g.querySelectorAll('.chip')];
    chips.forEach(b => b.classList.remove('active'));
    chips[Math.floor(Math.random() * chips.length)].classList.add('active');
  });
  void generate();
});

wireRefImage();
wireProviderModal();

loadProviders().then(list => {
  providers = list;
  renderModelSelect();
  render();
});
