import { decryptJson, encryptJson, type EncryptedPayload } from './crypto';

export interface SavedProvider {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  /** 用户勾选的可用模型 id 列表 */
  models: string[];
  createdAt: number;
}

export interface Prefs {
  selected?: { providerId: string; model: string };
}

const PROVIDERS_KEY = 'cw.providers.v1';
const PREFS_KEY = 'cw.prefs.v1';

export async function loadProviders(): Promise<SavedProvider[]> {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    if (!raw) return [];
    const payload = JSON.parse(raw) as EncryptedPayload;
    const data = await decryptJson<{ providers: SavedProvider[] }>(payload);
    return Array.isArray(data.providers) ? data.providers : [];
  } catch {
    return [];
  }
}

export async function saveProviders(providers: SavedProvider[]): Promise<void> {
  const payload = await encryptJson({ providers });
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(payload));
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Prefs) : {};
  } catch {
    return {};
  }
}

export function savePrefs(prefs: Prefs): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}
