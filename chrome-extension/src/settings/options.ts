import { unzipSync, strFromU8 } from 'fflate';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { modelEndpoint, type LocalConfig } from './config';
GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('settings/pdf.worker.mjs');

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const form = document.querySelector('form')!;
const resume = document.querySelector('textarea')!;
const status = document.getElementById('status')!;
let previous: LocalConfig | undefined;
let filename = '简历正文';
let loading = 0;

async function extract(file: File): Promise<string> {
  if (file.size > 10 * 1024 * 1024) throw new Error('文件超过 10 MB，请粘贴正文。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = file.name.split('.').pop()?.toLowerCase();
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
  input('base').value = previous.baseUrl; input('model').value = previous.model;
  input('key').value = previous.apiKey; resume.value = previous.resume.text; filename = previous.resume.name;
}
input('file').onchange = async () => {
  const file = input('file').files?.[0];
  if (!file) return;
  const id = ++loading;
  input('save').disabled = true;
  status.textContent = '正在本机读取简历…';
  try {
    const text = (await extract(file)).trim();
    if (id !== loading) return;
    if (!text) throw new Error('未提取到文字。扫描版 PDF 请先转成文字，或直接粘贴正文。');
    if (text.length > 80000) throw new Error('正文超过 8 万字，请手动粘贴所需内容。');
    resume.value = text; filename = file.name;
    status.textContent = '已读取 ' + filename + '，请核对后保存。';
  } catch (err) {
    if (id === loading) status.textContent = '导入失败。' + (err instanceof Error ? err.message : '请粘贴正文。');
  } finally { if (id === loading) input('save').disabled = false; }
};
form.onsubmit = async event => {
  event.preventDefault();
  try {
    const baseUrl = input('base').value.trim(), model = input('model').value.trim();
    modelEndpoint(baseUrl);
    const text = resume.value.trim();
    if (!text || !model) throw new Error('请填写简历和模型名称。');
    const revision = previous?.resume.text === text ? previous.resume.revision : crypto.randomUUID();
    const config: LocalConfig = { baseUrl, model, apiKey: input('key').value.trim(), resume: { text, name: filename, revision } };
    await chrome.storage.local.set({ applyConfig: config });
    previous = config;
    status.textContent = '已保存。回到招聘页面，点击职小搭扩展图标开始填写。';
  } catch (err) { status.textContent = err instanceof Error ? err.message : '保存失败，请重试。'; }
};
input('clear').onclick = async () => {
  if (!confirm('清除本扩展保存的简历、密钥和填写记录？请先结束正在进行的填写。')) return;
  ++loading;
  await chrome.storage.local.clear();
  previous = undefined; filename = '简历正文'; form.reset(); input('save').disabled = false;
  status.textContent = '本地资料、密钥和填写记录已清除。';
};
