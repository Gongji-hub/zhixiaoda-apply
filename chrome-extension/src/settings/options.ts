import { unzipSync, strFromU8 } from 'fflate';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { modelEndpoint, type LocalConfig, type LocalResumeFile } from './config';
GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('settings/pdf.worker.mjs');

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const form = document.querySelector('form')!;
const resume = document.querySelector('textarea')!;
const status = document.getElementById('status')!;
const dropzone = document.getElementById('dropzone')!;
const attachment = document.getElementById('attachment')!;
const modelStatus = document.getElementById('model-status')!;
const maxTextLength = 80_000;
let previous: LocalConfig | undefined;
let pendingResumeFile: LocalResumeFile | null = null;
let filename = '简历正文';
let importVersion = 0;

function showStatus(target: HTMLElement, message: string, state: 'busy' | 'success' | 'error') {
  target.dataset.state = state;
  target.textContent = message;
  target.hidden = false;
}

function renderAttachment() {
  attachment.hidden = !pendingResumeFile;
  document.getElementById('attachment-name')!.textContent = pendingResumeFile?.fileName || '';
}

function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 24_576) {
    parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24_576))));
  }
  return parts.join('');
}

async function extract(bytes: Uint8Array, ext: string | undefined): Promise<string> {
  if (ext === 'txt' || ext === 'md') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (ext === 'docx') {
    const part = 'word/document.xml';
    const xml = unzipSync(bytes, { filter(entry) {
      if (entry.name !== part) return false;
      if (entry.originalSize > 5_000_000) throw new Error('Word 正文过大，请粘贴正文。');
      return true;
    } })[part];
    if (!xml) throw new Error('无法找到 Word 正文。');
    const doc = new DOMParser().parseFromString(strFromU8(xml), 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Word 文件格式有误。');
    return Array.from(doc.getElementsByTagNameNS('*','p'), p =>
      Array.from(p.getElementsByTagNameNS('*','t'), n => n.textContent).join('')
    ).join('\n');
  }
  if (ext !== 'pdf') throw new Error('请选择 PDF、DOCX、TXT 或 Markdown 文件。');
  const pdf = await getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true,
    cMapUrl: chrome.runtime.getURL('settings/cmaps/'), cMapPacked: true }).promise;
  try {
    const lines: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const { items } = await page.getTextContent();
      lines.push(items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join(''));
    }
    return lines.join('\n');
  } finally { await pdf.destroy(); }
}

await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
previous = (await chrome.storage.local.get('applyConfig')).applyConfig;
if (previous) {
  input('base').value = previous.baseUrl;
  input('model').value = previous.model;
  input('key').value = previous.apiKey;
  resume.value = previous.resume.text;
  filename = previous.resume.name;
  pendingResumeFile = previous.resumeFile ?? null;
  input('auto-upload').checked = previous.autoUploadResume !== false;
}
renderAttachment();

async function importResume(file: File) {
  const version = ++importVersion;
  button('save').disabled = true;
  showStatus(status, '正在本机读取简历…', 'busy');
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请粘贴正文。');
    const ext = file.name.split('.').pop()?.toLowerCase();
    const bytes = new Uint8Array(await file.arrayBuffer());
    // PDF.js can transfer the input buffer to its worker during extraction.
    const original = ext === 'pdf' || ext === 'docx' ? {
      fileName: file.name,
      mimeType: ext === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: toBase64(bytes),
      sizeBytes: file.size,
    } : null;
    const text = (await extract(bytes, ext)).trim();
    if (version !== importVersion) return;
    if (!text) throw new Error('未提取到文字。扫描版 PDF 请先转成文字，或直接粘贴正文。');
    if (text.length > maxTextLength) throw new Error('正文超过 8 万字，请手动粘贴所需内容。');
    resume.value = text;
    filename = file.name;
    pendingResumeFile = original;
    renderAttachment();
    showStatus(status, `已读取 ${filename}，请核对正文后保存。`, 'success');
  } catch (error) {
    if (version === importVersion) showStatus(status, `导入失败。${error instanceof Error ? error.message : '请粘贴正文。'}`, 'error');
  } finally {
    if (version === importVersion) button('save').disabled = false;
  }
}

input('file').addEventListener('change', () => {
  const file = input('file').files?.[0];
  if (file) void importResume(file);
  input('file').value = '';
});

dropzone.addEventListener('dragover', event => {
  event.preventDefault();
  dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', event => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file) void importResume(file);
});
button('remove-attachment').addEventListener('click', () => {
  pendingResumeFile = null;
  renderAttachment();
  showStatus(status, '已移除原件，简历正文仍可用于填写。请保存设置。', 'success');
});

button('test-model').addEventListener('click', async () => {
  const test = button('test-model');
  test.disabled = true;
  showStatus(modelStatus, '正在测试模型连接…', 'busy');
  const signal = AbortSignal.timeout(15_000);
  try {
    const endpoint = modelEndpoint(input('base').value.trim());
    const model = input('model').value.trim();
    const apiKey = input('key').value.trim();
    if (!model) throw new Error('请填写模型名称。');
    const started = performance.now();
    const response = await fetch(endpoint, {
      method: 'POST', credentials: 'omit', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false }),
    }).catch(() => {
      throw new Error(signal.aborted ? '连接超时，请检查 API 地址或稍后重试。' : '连接失败，请检查 API 地址和网络。');
    });
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? '请检查 API Key 和模型权限。' : '请检查 API 地址和模型名称。';
      throw new Error(`请求失败（HTTP ${response.status}）。${hint}`);
    }
    const body = await response.json().catch(() => null);
    if (signal.aborted) throw new Error('读取模型响应超时，请稍后重试。');
    if (!body?.choices?.[0]?.message) throw new Error(`接口返回 HTTP ${response.status}，请确认该地址支持 Chat Completions。`);
    showStatus(modelStatus, `连接成功 · HTTP ${response.status} · ${Math.round(performance.now() - started)} ms`, 'success');
  } catch (error) {
    showStatus(modelStatus, error instanceof Error ? error.message : '连接测试失败，请重试。', 'error');
  } finally {
    test.disabled = false;
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const save = button('save');
  if (save.disabled) return;
  save.disabled = true;
  try {
    const baseUrl = input('base').value.trim();
    const model = input('model').value.trim();
    const text = resume.value.trim();
    modelEndpoint(baseUrl);
    if (!text || !model) throw new Error('请填写简历和模型名称。');
    if (text.length > maxTextLength) throw new Error('简历正文请控制在 8 万字以内。');
    const revision = previous?.resume.text === text ? previous.resume.revision : crypto.randomUUID();
    const config: LocalConfig = {
      baseUrl,
      model,
      apiKey: input('key').value.trim(),
      resume: { text, name: filename, revision },
      resumeFile: pendingResumeFile,
      autoUploadResume: input('auto-upload').checked,
    };
    await chrome.storage.local.set({ applyConfig: config });
    previous = config;
    showStatus(status, '已保存。回到招聘页，点击浮标或浏览器工具栏中的职小搭图标开始填写。', 'success');
  } catch (error) {
    showStatus(status, error instanceof Error ? error.message : '保存失败，请重试。', 'error');
  } finally {
    save.disabled = false;
  }
});

button('clear').addEventListener('click', async () => {
  if (!confirm('清除本扩展保存的简历、密钥、填写进度、控件记录和本地诊断？正在进行的填写也会停止。')) return;
  ++importVersion;
  try {
    button('save').disabled = true;
    button('clear').disabled = true;
    const result = await chrome.runtime.sendMessage({ type: 'standalone_clear_local_data' });
    if (result?.ok !== true) throw new Error('清除失败');
    previous = undefined;
    pendingResumeFile = null;
    filename = '简历正文';
    form.reset();
    renderAttachment();
    modelStatus.hidden = true;
    showStatus(status, '本扩展的本地数据已清除。', 'success');
  } catch {
    showStatus(status, '清除失败，请重试。', 'error');
  } finally {
    button('save').disabled = false;
    button('clear').disabled = false;
  }
});
