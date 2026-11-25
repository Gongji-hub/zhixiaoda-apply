export interface LocalResumeFile {
  fileName: string;
  mimeType: string;
  base64: string;
  sizeBytes: number;
}

export interface LocalConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  resume: { name: string; text: string; revision: string };
  resumeFile?: LocalResumeFile | null;
  autoUploadResume?: boolean;
}

export function modelEndpoint(base: string): string {
  let url: URL;
  const invalid = 'API 地址请输入 HTTPS 地址，或本机 localhost / 127.0.0.1 地址，且不要附带账号、查询参数或片段。';
  try {
    url = new URL(base);
  } catch {
    throw new Error(invalid);
  }
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new Error(invalid);
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions') ? path : path + '/chat/completions';
  return url.href;
}

export function hasReadyConfig(config: unknown): config is LocalConfig {
  if (!config || typeof config !== 'object') return false;
  const { baseUrl, model, apiKey, resume } = config as Partial<LocalConfig>;
  if (typeof baseUrl !== 'string' || typeof model !== 'string' || !model.trim() || typeof apiKey !== 'string' ||
      typeof resume?.text !== 'string' || !resume.text.trim() ||
      typeof resume.name !== 'string' || typeof resume.revision !== 'string' || !resume.revision) return false;
  try {
    modelEndpoint(baseUrl);
    return true;
  } catch {
    return false;
  }
}

export async function readConfig(): Promise<LocalConfig> {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const { applyConfig } = await chrome.storage.local.get('applyConfig');
  if (!hasReadyConfig(applyConfig)) throw new Error('请先导入简历并保存模型设置。');
  return applyConfig;
}
