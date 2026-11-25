<div align="center">

<img src="chrome-extension/public/icon-128.png" width="84" height="84" alt="职小搭 · 网申助手图标" />

# 职小搭 · 网申助手

**用本地简历和自己的模型 API，在招聘官网一键填表并逐项核对的 Chrome / Edge 扩展。**

<p>
  <img src="https://img.shields.io/badge/Chrome%20%7C%20Edge-120%2B-555?style=flat-square" alt="Browser" />
  <img src="https://img.shields.io/badge/Manifest-V3-00c4b8?style=flat-square" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/license-Apache%202.0-0869d8?style=flat-square" alt="Apache-2.0 License" />
</p>

<p>
  <strong>简体中文</strong> · <a href="README_EN.md">English</a>
</p>

<p>
  <a href="#特性">特性</a> ·
  <a href="#界面预览">界面预览</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#隐私说明">隐私说明</a> ·
  <a href="#协议与致谢">协议与致谢</a>
</p>

<br />

<img src="docs/screenshots/hero-preview.png" alt="职小搭 · 网申助手页内自动填写预览" width="100%" />

</div>

---

## 特性

- **页内悬浮操作**：进入招聘表单页自动浮现右下角启动胶囊，顶部悬浮卡展示填写进度；切走标签页自动暂停，不挤占页面宽度。
- **适配常见招聘组件**：内置 Moka、飞书 Formily、Phoenix、Ant Design、Element 的日期面板、搜索/虚拟下拉、多级级联与多段经历动态展开；遇到未适配控件可按需局部截图探索，成功后本地记住操作步骤，同站下次复用。
- **写完回读与遗漏巡检**：填入后检查页面真实值与校验提示，避免假成功；整页完成后再独立扫描屏外区域、可读 iframe 与开放 Shadow DOM，标出漏填的必填项和报错。
- **本地解析与原件自动上传**：浏览器内解析文字版 PDF、DOCX、TXT、Markdown（≤ 10 MB / 8 万字）；导入 PDF/DOCX 时自动保留原件，遇到简历上传区自动挂载并关闭覆盖弹窗。
- **不瞎填、不代提交**：缺必填信息或需替换已有值时在悬浮卡内直接确认，选填缺失项留空不打断；结束后可在清单内直接选网页下拉、勾协议、定位字段或复制脱敏诊断提 Issue，登录、验证码和最终提交始终由你本人完成。

---

## 界面预览

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/screenshots/settings.png" width="100%" alt="简历与模型设置" />
      <br /><sub><b>简历与模型设置</b> — 拖放导入、原件上传开关与接口连通性测试</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/screenshots/floating-entry.png" width="100%" alt="表单页浮标" />
      <br /><sub><b>表单页浮标</b> — 识别招聘表后一键启动或直达设置</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/screenshots/qa-overlay.png" width="100%" alt="页内确认" />
      <br /><sub><b>页内确认</b> — 缺失必填项直接选填，同步高亮对应字段</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/screenshots/review-checklist.png" width="100%" alt="核对与补填" />
      <br /><sub><b>核对与补填</b> — 清单内直接选网页下拉、勾协议、定位及复制诊断</sub>
    </td>
  </tr>
</table>

---

## 快速开始

需要 **Node.js 22.12+**、**Chrome / Edge 120+**，以及支持工具调用（Tool Calling）的 OpenAI 兼容模型 API。

```bash
git clone https://github.com/Gongji-hub/zhixiaoda-apply.git
cd zhixiaoda-apply
npm ci
npm run build
```

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启**开发者模式**，加载生成的 `dist` 目录。
2. 点击工具栏扩展图标进入设置页：拖入简历文件（扫描版 PDF 需先 OCR）或粘贴正文；填入 `API Base URL`（如 `https://api.openai.com/v1` 或本机 `http://localhost:11434/v1`）、`模型名称` 和 `API Key`（本机免鉴权可留空），点**测试模型连接**通过后保存。
3. 打开招聘申请表页面，点右下角浮标或扩展图标开始填写；核对悬浮卡清单后自行提交。

> 未知控件探索需要多模态模型；纯文本模型可正常完成常规填表，遇到未适配控件会转入核对清单由你手动处理。运行单元测试可执行 `npm test`。

---

## 隐私说明

- 简历正文、原件、API Key、填写进度、本地控件配方与诊断记录仅保存在浏览器私有 `chrome.storage.local`（`TRUSTED_CONTEXTS` 隔离），网页脚本不可读取。
- 仅在启动填写时将简历正文、页面表单信息和本轮回答发往你配置的模型地址（未知控件探索附带局部截图）；API 地址仅允许 `https://` 或本机 `localhost` / `127.0.0.1`。
- 设置页支持一键清除全部本地数据；点击悬浮卡「反馈 → 复制诊断」生成的文本会自动脱敏 URL 中的长 ID 与邮箱，且不包含个人简历值，可直接附在 GitHub Issue 中反馈适配问题。

---

## 协议与致谢

浏览器自动化基于 [Nanobrowser](https://github.com/nanobrowser/nanobrowser)（Apache-2.0），招聘组件适配参考 [OfferGo](https://github.com/Suara17/OfferGo-resume-filler-extension)（MIT），详情见 [UPSTREAM.md](UPSTREAM.md)。

Licensed under the [Apache License 2.0](LICENSE).
