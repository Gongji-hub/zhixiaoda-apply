export interface LocalConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  resume: { name: string; text: string; revision: string };
}

export function modelEndpoint(base: string) {
  const url = new URL(base);
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash)
    throw new Error('API 地址请输入 HTTPS 地址，或本机 localhost / 127.0.0.1 地址。');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/chat/completions';
  return url.href;
}

export async function readConfig(): Promise<LocalConfig> {
  const { applyConfig } = await chrome.storage.local.get('applyConfig');
  if (!applyConfig?.model || !applyConfig.baseUrl || !applyConfig.resume?.text?.trim())
    throw new Error('请先导入简历并保存模型设置。');
  modelEndpoint(applyConfig.baseUrl);
  return applyConfig;
}
