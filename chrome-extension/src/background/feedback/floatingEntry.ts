/** Lightweight floating entry for supported application forms. */
export function renderApplicationFloatingEntry(config: { enabled: boolean; resumeName?: string } | null) {
  const key = '__qzFloatingEntry';
  const scope = window as unknown as Record<string, { cleanup: () => void; dismissedPath?: string }>;
  if (!config || !config.enabled) {
    scope[key]?.cleanup();
    delete scope[key];
    document.getElementById('qz-agent-floating-entry')?.remove();
    return;
  }
  if (scope[key]) return;

  let dismissedRoute = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const isFormPage = (): boolean => {
    if (document.getElementById('qz-agent-feedback')) return false;
    if (document.fullscreenElement) return false;
    const currentRoute = location.pathname + location.hash;
    if (dismissedRoute && dismissedRoute === currentRoute) return false;

    const layoutRendered = document.body ? document.body.getBoundingClientRect().width > 0 : false;
    const rawControls = Array.from(
      document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="password"]):not([type="search"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]), textarea, select, [role="combobox"], .ud__select, .ant-select, .el-select, .phoenix-select',
      ),
    );
    const controls = rawControls.filter(el => {
      if (
        el.tagName === 'INPUT' &&
        el.closest('[role="combobox"], .ud__select, .ant-select, .el-select, .phoenix-select')
      ) {
        return false;
      }
      if (el.closest('[hidden], [aria-hidden="true"]')) return false;
      const hint = `${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''}`;
      if (/搜索|弹幕|评论|回复|查找|发消息|search|comment|danmu/i.test(hint)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      if (
        typeof (el as HTMLElement).checkVisibility === 'function' &&
        !(el as HTMLElement).checkVisibility({ visibilityProperty: true })
      ) {
        return false;
      }
      const box = el.getBoundingClientRect();
      if (!layoutRendered && box.width === 0 && box.height === 0) return true;
      return box.width > 40 && box.height > 16;
    });

    if (controls.length < 4) return false;

    const labelChunks: string[] = [];
    for (const el of controls.slice(0, 60)) {
      const placeholder = el.getAttribute('placeholder') || '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      if (placeholder) labelChunks.push(placeholder);
      if (ariaLabel) labelChunks.push(ariaLabel);
      const item = el.closest(
        'label, .ud-formily-item, .ud-form-item, .ant-form-item, .el-form-item, .phoenix-form-item, .moka-form-item, [class*="form-item" i], fieldset, tr',
      );
      if (item) {
        labelChunks.push((item.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120));
      } else if (el.parentElement) {
        labelChunks.push((el.parentElement.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80));
      }
    }
    for (const labelEl of Array.from(
      document.querySelectorAll('label, [class*="form-item-label" i], [class*="formily-item-label" i]'),
    ).slice(0, 80)) {
      labelChunks.push((labelEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60));
    }
    const labelCorpus = labelChunks.join(' ');
    const resumeFieldPatterns = [
      /姓名|中文名|英文名|真实姓名/,
      /性别/,
      /出生日期|出生年月|生日/,
      /手机号|手机号码|联系电话|移动电话|电话号码/,
      /邮箱|电子邮箱|电子邮件|e-?mail/i,
      /籍贯|国籍|民族|政治面貌|户口|户籍/,
      /身份证|证件号|证件类型/,
      /现居|居住地|所在城市|当前城市|通讯地址/,
      /教育经历|教育背景|毕业院校|学校名称|院校名称/,
      /学历|学位|专业名称|所学专业/,
      /工作经历|实习经历|公司名称|单位名称|职位名称|工作职责/,
      /项目经历|项目名称|项目描述|项目职责/,
      /期望薪资|目前年薪|到岗时间|求职意向/,
    ];
    let matchedCategories = 0;
    for (const pattern of resumeFieldPatterns) {
      if (pattern.test(labelCorpus)) matchedCategories++;
    }
    if (matchedCategories < 3) return false;

    const headingText = Array.from(document.querySelectorAll('h1, h2, h3, [class*="title" i]'))
      .slice(0, 15)
      .map(el => (el.textContent || '').trim())
      .join(' ');
    const pageContext = `${location.href} ${document.title} ${headingText}`;
    const hasAtsContainer = Boolean(document.querySelector('.ud-formily-item, .phoenix-form-item, .moka-form-item'));
    const hasRecruitingContext =
      hasAtsContainer ||
      /简历|网申|投递|应聘|申请|招聘|校招|社招|求职|职位|候选人|基本信息|个人信息|教育经历|教育背景|工作经历|resume|career|apply|job|recruit|candidate/i.test(
        pageContext,
      );
    return hasRecruitingContext;
  };

  const ensureMounted = () => {
    const existing = document.getElementById('qz-agent-floating-entry');
    if (!isFormPage()) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const host = document.createElement('div');
    host.id = 'qz-agent-floating-entry';
    host.style.cssText =
      'all:initial!important;position:fixed!important;right:22px!important;bottom:32px!important;z-index:2147483645!important;pointer-events:auto!important;';
    const root = host.attachShadow({ mode: 'closed' });
    const logoUrl =
      typeof chrome !== 'undefined' && typeof chrome.runtime?.getURL === 'function'
        ? chrome.runtime.getURL('job-panel/brand-symbol.png')
        : '';
    const logoGraphic = logoUrl ? `<img class="logo-img" src="${logoUrl}" alt="" />` : '职';
    root.innerHTML = `<style>
      *{box-sizing:border-box}
      .pill{display:flex;align-items:center;gap:9px;padding:8px 11px 8px 10px;border-radius:999px;border:1px solid rgba(8,105,216,.24);background:rgba(255,255,255,.96);box-shadow:0 12px 28px -6px rgba(8,105,216,.24),0 2px 8px rgba(15,23,42,.08);font:600 12.5px/1.3 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif;color:#0f172a;backdrop-filter:blur(12px);transition:transform .15s,box-shadow .15s}
      .pill:hover{transform:translateY(-1px);box-shadow:0 14px 32px -6px rgba(8,105,216,.30)}
      .launch{display:flex;align-items:center;gap:8px;border:none;background:transparent;padding:0;margin:0;cursor:pointer;color:inherit;font:inherit}
      .logo{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#ffffff,#f0f9ff);border:1px solid rgba(198,220,240,.9);color:#0869d8;font-size:12px;font-weight:700;box-shadow:0 2px 6px rgba(8,105,216,.12)}
      .logo-img{width:20px;height:14px;object-fit:contain;display:block;pointer-events:none}
      .text{display:flex;flex-direction:column;align-items:flex-start}
      .main-text{font-size:12.5px;font-weight:650;color:#0869d8}
      .sub-text{font-size:10px;font-weight:500;color:#64748b}
      .close,.settings{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;border:none;background:transparent;color:#94a3b8;cursor:pointer;font-size:13px;padding:0;line-height:1}
      .close:hover,.settings:hover{background:#f1f5f9;color:#475569}
    </style><div class="pill"><button type="button" class="launch"><span class="logo">${logoGraphic}</span><span class="text"><span class="main-text">一键填写简历</span><span class="sub-text">职小搭 · 自动填入表单</span></span></button><button type="button" class="settings" aria-label="简历与模型设置" title="简历与模型设置">⚙</button><button type="button" class="close" aria-label="关闭">×</button></div>`;
    const launchBtn = root.querySelector('.launch') as HTMLButtonElement;
    const mainText = root.querySelector('.main-text') as HTMLElement;
    const closeBtn = root.querySelector('.close') as HTMLButtonElement;
    launchBtn.addEventListener('click', event => {
      if (!event.isTrusted) return;
      launchBtn.disabled = true;
      mainText.textContent = '正在启动填写…';
      void chrome.runtime.sendMessage({ type: 'application_floating_launch' }).catch(() => {}).finally(() => {
        host.remove();
      });
    });
    root.querySelector('.settings')?.addEventListener('click', event => {
      if (!event.isTrusted) return;
      void chrome.runtime.sendMessage({ type: 'application_floating_open_settings' }).catch(() => {});
    });
    closeBtn.addEventListener('click', event => {
      if (!event.isTrusted) return;
      dismissedRoute = location.pathname + location.hash;
      host.remove();
    });
    document.documentElement.append(host);
  };

  ensureMounted();
  const onRouteOrScreenChange = () => ensureMounted();
  window.addEventListener('hashchange', onRouteOrScreenChange);
  window.addEventListener('popstate', onRouteOrScreenChange);
  document.addEventListener('fullscreenchange', onRouteOrScreenChange);
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      ensureMounted();
    }, 700);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scope[key] = {
    cleanup: () => {
      observer.disconnect();
      window.removeEventListener('hashchange', onRouteOrScreenChange);
      window.removeEventListener('popstate', onRouteOrScreenChange);
      document.removeEventListener('fullscreenchange', onRouteOrScreenChange);
      if (timer) clearTimeout(timer);
      document.getElementById('qz-agent-floating-entry')?.remove();
    },
  };
}
