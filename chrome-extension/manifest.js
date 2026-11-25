export default {
  manifest_version: 3,
  minimum_chrome_version: '120',
  version: '0.9.13',
  default_locale: 'zh_CN',
  name: '职小搭 · 网申助手',
  description: '导入简历并配置模型 API，在招聘官网悬浮一键填写表单并逐项核对。',
  permissions: ['storage', 'scripting', 'tabs', 'activeTab', 'debugger', 'unlimitedStorage', 'webNavigation'],
  host_permissions: ['https://*/*', 'http://127.0.0.1/*', 'http://localhost/*'],
  background: { service_worker: 'background.js', type: 'module' },
  options_page: 'settings/index.html',
  action: { default_icon: 'icon-32.png', default_title: '职小搭 · 网申助手' },
  icons: { 32: 'icon-32.png', 128: 'icon-128.png' },
  web_accessible_resources: [{
    resources: ['icon-128.png', 'icon-32.png', 'brand-icon.svg', 'job-panel/brand-symbol.png'],
    matches: ['https://*/*', 'http://127.0.0.1/*', 'http://localhost/*'],
  }],
};
