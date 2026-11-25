export function positionFeedbackCard(host: HTMLElement, besideDialog = false) {
  const position = besideDialog
    ? 'left:auto!important;right:12px!important;transform:none!important;width:min(360px,calc(100vw - 24px))!important;'
    : 'left:50%!important;right:auto!important;transform:translateX(-50%)!important;width:min(560px,calc(100vw - 24px))!important;';
  host.style.cssText = `all:initial!important;position:fixed!important;top:0px!important;bottom:auto!important;display:flex!important;justify-content:center!important;${position}z-index:2147483647!important;pointer-events:none!important;`;
}

export function createCardLayout() {
  const host = document.createElement('div');
  host.id = 'qz-agent-feedback';
  positionFeedbackCard(host);
  const root = host.attachShadow({ mode: 'closed' });
  const markGraphic =
    '<svg class="mark-svg" viewBox="8 10 64 60" fill="none"><g class="mark-mascot"><g transform="translate(41 40) rotate(14)"><path d="M-15 -22 H15 A10 10 0 0 1 25 -12 V11 A10 10 0 0 1 15 21 H-9 C-13 25 -19 27 -25 26 C-21 23 -19.5 19.5 -20 16.5 A10 10 0 0 1 -25 8 V-12 A10 10 0 0 1 -15 -22 Z" fill="#FFFFFF" stroke="#00C4B8" stroke-width="6.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="-7.5" cy="-2" r="4" fill="#0E3C96"/><path d="M3.5 -2 Q8.5 -7.5 12.5 -1" stroke="#0E3C96" stroke-width="4" stroke-linecap="round"/><path d="M-5 6.2 Q0 10.8 5 6.2" stroke="#0E3C96" stroke-width="3.8" stroke-linecap="round"/></g></g></svg>';
  const chevronDown =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4.5 6.2L8 9.7L11.5 6.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const chevronUp =
    '<svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M4.5 9.8L8 6.3L11.5 9.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  root.innerHTML = `<style>
    :host{color-scheme:light;display:flex;justify-content:center;width:100%}*{box-sizing:border-box}
    @keyframes qzBreatheHalo{0%,100%{transform:scale(1);opacity:.42}50%{transform:scale(1.9);opacity:0}}
    @keyframes qzLogoFloat{0%,100%{transform:translateY(0) rotate(0deg)}50%{transform:translateY(-.9px) rotate(-4deg)}}
    @keyframes qzTrackFlow{0%{transform:translateX(-110%)}100%{transform:translateX(240%)}}
    @keyframes qzSlideFadeIn{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}
    @keyframes qzPillPop{0%{transform:scale(1)}45%{transform:scale(1.07)}100%{transform:scale(1)}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
    /* Shared light frosted glass family across collapsed ice-blue pill & expanded workbench (zero color jump). */
    .card{position:relative;display:flex;flex-direction:column;gap:10px;width:100%;max-width:100%;padding:12px 17px 15px;overflow:hidden;border-radius:0 0 20px 20px;background:rgba(255,255,255,.95);color:#0f172a;border:1px solid rgba(14,165,233,.26);border-top:none;box-shadow:0 16px 40px -10px rgba(15,23,42,.16),0 4px 12px rgba(15,23,42,.05);backdrop-filter:blur(20px) saturate(1.4);font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif;pointer-events:auto;transition:border-radius .24s cubic-bezier(.22,1,.36,1),border-color .3s ease,box-shadow .3s ease,background .3s ease}
    .card.paused{border-color:rgba(148,163,184,.34);box-shadow:0 14px 36px -10px rgba(15,23,42,.14),0 4px 12px rgba(15,23,42,.05)}
    .card.waiting{background:rgba(255,254,250,.96);border-color:rgba(245,158,11,.42);box-shadow:0 16px 40px -10px rgba(217,119,6,.18),0 4px 12px rgba(15,23,42,.05)}
    .card.done{border-color:rgba(16,185,129,.34);box-shadow:0 14px 34px -10px rgba(16,185,129,.15),0 4px 10px rgba(15,23,42,.04)}
    .card.done.has-warn{border-color:rgba(245,158,11,.38);box-shadow:0 16px 38px -10px rgba(217,119,6,.16),0 4px 12px rgba(15,23,42,.05)}
    .stage-track[hidden],.brand[hidden],.pill-progress[hidden],.extra[hidden],button[hidden],input[hidden],.unfilled-box[hidden],.feedback-box[hidden],.feedback-status[hidden],.stat-pill[hidden],.item-drawer[hidden],.item-error[hidden],.drawer-crumb[hidden],.drawer-search-row[hidden],.drawer-status[hidden]{display:none!important}
    /* Zone 1 (Expanded): Top 4-stage track + right-aligned collapse chip */
    .stage-track{display:flex;align-items:center;gap:8px;padding-bottom:10px;border-bottom:1px solid #f1f5f9}
    .stage-item{display:flex;align-items:center;gap:6px;flex-shrink:0}
    .stage-dot-wrap{position:relative;width:14px;height:14px;display:grid;place-items:center;flex-shrink:0}
    .stage-halo{position:absolute;inset:0;border-radius:999px;background:#0ea5e9;animation:qzBreatheHalo 2.2s ease-out infinite}
    .waiting .stage-halo{background:#f59e0b}
    .stage-label{font-size:12px;color:#94a3b8;transition:color .25s ease}
    .stage-label.done{font-weight:500;color:#475569}
    .stage-label.active-run{font-weight:600;color:#0369a1}
    .stage-label.active-wait{font-weight:600;color:#b45309}
    .stage-label.active-pause{font-weight:600;color:#334155}
    .stage-label.active-done{font-weight:600;color:#047857}
    .stage-line{position:relative;flex:1;height:2px;min-width:12px;background:#e2e8f0;border-radius:999px;overflow:hidden}
    .stage-line-fill{position:absolute;inset:0;background:linear-gradient(90deg,#00C4B8,#0869d8);transform:scaleX(0);transform-origin:left center;transition:transform .5s cubic-bezier(.22,1,.36,1)}
    .stage-line-fill.filled{transform:scaleX(1)}
    .stage-line-beam{position:absolute;top:0;bottom:0;width:45%;background:linear-gradient(90deg,transparent,rgba(14,165,233,.85),transparent);animation:qzTrackFlow 1.8s ease-in-out infinite}
    .stage-line-beam[hidden]{display:none!important}
    .collapse-chip{display:inline-flex;align-items:center;gap:3px;margin-left:4px;padding:2px 8px;border:1px solid #e2e8f0;border-radius:999px;background:#f8fafc;color:#64748b;font-size:11px;font-weight:600;line-height:1.35;flex-shrink:0}
    .collapse-chip:hover:not(:disabled){background:#f1f5f9;border-color:#cbd5e1;color:#0f172a}
    /* Zone 2 (Expanded): Substantial 40px Xiaoda badge + tight title/detail + tactile buttons */
    .main{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
    .mark{display:grid;place-items:center;width:40px;height:40px;flex-shrink:0;background:#E8FAF8;border:1px solid rgba(0,196,184,.25);border-radius:12px;box-shadow:0 4px 12px rgba(0,196,184,.12);transition:background .25s ease,border-color .25s ease,box-shadow .25s ease}
    .mark-svg{display:block;width:30px;height:30px}
    .mark .mark-mascot{transform-box:fill-box;transform-origin:center}
    .card.running .mark .mark-mascot{animation:qzLogoFloat 2.6s ease-in-out infinite}
    .card.waiting .mark,.card.done.has-warn .mark{background:#fffbeb;border-color:rgba(252,211,77,.85);box-shadow:0 4px 12px rgba(217,119,6,.12)}
    .card.done .mark{background:#ecfdf5;border-color:rgba(110,231,183,.85);box-shadow:0 4px 12px rgba(16,185,129,.12)}
    .copy{flex:1 1 184px;min-width:min(184px,100%)}
    .brand{display:block;margin-bottom:2px;font-size:11px;font-weight:600;color:#64748b;letter-spacing:.02em}
    .title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .title{font-weight:650;font-size:14px;line-height:1.35;letter-spacing:-.01em;color:#0f172a}
    .stat-pill{display:inline-flex;align-items:center;white-space:nowrap;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;line-height:1.35;background:#f0f9ff;color:#0369a1;border:1px solid rgba(186,230,253,.85);font-variant-numeric:tabular-nums}
    .stat-pill.warn{background:#fffbeb;color:#b45309;border-color:rgba(253,230,138,.9)}
    .stat-pill.pop{animation:qzPillPop .26s ease-out}
    .detail{margin-top:2px;font-size:12px;line-height:1.45;color:#64748b;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
    .card.waiting .detail,.card.beside-dialog .detail{-webkit-line-clamp:3}
    .detail.slide{animation:qzSlideFadeIn .22s cubic-bezier(.22,1,.36,1)}
    .actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:7px;align-items:center;flex-shrink:0;min-width:0;max-width:100%;margin-left:auto}
    .card.beside-dialog .actions{flex-basis:100%;margin-top:2px}
    .actions button{white-space:nowrap}
    button,input{pointer-events:auto;font:600 12px -apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif}
    button{flex-shrink:0;border:1px solid #e2e8f0;border-radius:10px;padding:7px 14px;background:#fff;color:#334155;cursor:pointer;transition:background .15s,border-color .15s,color .15s,filter .15s}
    button:hover:not(:disabled){background:#f8fafc;border-color:#cbd5e1}
    button.primary.highlight{background:linear-gradient(135deg,#0869d8,#0284c7);border-color:transparent;color:#fff;box-shadow:0 4px 12px rgba(8,105,216,.24)}
    button.primary.highlight:hover:not(:disabled){filter:brightness(1.06)}
    .card.waiting button.primary.highlight{background:linear-gradient(135deg,#d97706,#ea580c);box-shadow:0 4px 12px rgba(217,119,6,.24)}
    button:focus-visible,input:focus-visible{outline:2px solid #0869d866;outline-offset:2px}
    button:disabled{cursor:default;opacity:.55}
    .expand-toggle{display:none}
    .pill-live-dot{display:none;position:relative;width:7px;height:7px;border-radius:999px;background:#0284c7;box-shadow:0 0 6px rgba(2,132,199,.55);flex-shrink:0}
    .pill-live-dot::after{content:"";position:absolute;inset:-3px;border-radius:999px;background:rgba(56,189,248,.55);animation:qzBreatheHalo 2.1s ease-out infinite}
    /* ===== COLLAPSED TOP-DOCKED ICE-BLUE TINTED GLASS PILL (strict single-line, distinct from white navbars) ===== */
    .card.is-collapsed{width:fit-content;min-width:min(330px,100%);gap:0;padding:8px 10px 10px 13px;border-radius:0 0 16px 16px;background:linear-gradient(135deg,rgba(235,246,255,.95) 0%,rgba(242,250,255,.95) 55%,rgba(232,251,249,.94) 100%);border:1px solid rgba(14,165,233,.36);border-top:none;box-shadow:0 12px 30px -6px rgba(8,105,216,.20),0 3px 8px rgba(15,23,42,.06),inset 0 1px 0 rgba(255,255,255,.8)}
    .card.is-collapsed.done{background:linear-gradient(135deg,rgba(236,253,245,.96),rgba(240,253,250,.95));border-color:rgba(16,185,129,.38);box-shadow:0 12px 28px -6px rgba(16,185,129,.16),0 3px 8px rgba(15,23,42,.05)}
    .card.is-collapsed.waiting,.card.is-collapsed.done.has-warn{background:linear-gradient(135deg,rgba(255,251,235,.97),rgba(254,243,199,.92));border-color:rgba(245,158,11,.45);box-shadow:0 12px 28px -6px rgba(217,119,6,.18),0 3px 8px rgba(15,23,42,.05)}
    .card.is-collapsed.paused{background:rgba(241,245,249,.96);border-color:rgba(148,163,184,.40);box-shadow:0 10px 24px -6px rgba(15,23,42,.12),0 2px 6px rgba(15,23,42,.05)}
    .card.is-collapsed .stage-track,.card.is-collapsed .extra,.card.is-collapsed .unfilled-box,.card.is-collapsed .feedback-box{display:none}
    .card.is-collapsed .main{flex-wrap:nowrap;gap:10px;min-width:0;max-width:100%}
    .card.is-collapsed .mark{width:22px;height:22px;background:transparent;border:none;border-radius:0;box-shadow:none}
    .card.is-collapsed .mark-svg{width:22px;height:22px}
    .card.is-collapsed .copy{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:184px;overflow:hidden}
    .card.is-collapsed .title-row{display:contents}
    .card.is-collapsed.running .pill-live-dot{display:inline-block;order:0}
    .card.is-collapsed .title{order:1;font-size:13px;font-weight:600;line-height:1.35;color:#0c2a4d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
    .card.is-collapsed.running.has-live-detail .title{display:none}
    .card.is-collapsed .detail{display:none}
    .card.is-collapsed.running.has-live-detail .detail{display:block;order:1;margin-top:0;font-size:13px;font-weight:600;line-height:1.35;color:#0c2a4d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;-webkit-line-clamp:unset;min-width:0}
    .card.is-collapsed .stat-pill{order:2;flex-shrink:0;padding:2px 8px;border:1px solid rgba(14,165,233,.24);border-radius:999px;background:rgba(255,255,255,.82);color:#0369a1;font-size:11px;font-weight:600;line-height:1.3}
    .card.is-collapsed .stat-pill.warn{background:#fffbeb;border-color:rgba(245,158,11,.45);color:#b45309}
    .card.is-collapsed .actions{flex-wrap:nowrap;gap:6px;padding-left:10px;border-left:1px solid rgba(8,105,216,.18)}
    .card.is-collapsed .actions button.primary,.card.is-collapsed .actions button.secondary,.card.is-collapsed .actions button.copy-trace,.card.is-collapsed .actions button.report-feedback{border:1px solid rgba(14,165,233,.30);border-radius:999px;padding:4px 12px;font-size:11.5px;font-weight:600;line-height:1.3;background:rgba(255,255,255,.88);color:#0c4a6e;box-shadow:0 1px 2px rgba(8,105,216,.08)}
    .card.is-collapsed .actions button.primary:hover:not(:disabled),.card.is-collapsed .actions button.secondary:hover:not(:disabled),.card.is-collapsed .actions button.copy-trace:hover:not(:disabled),.card.is-collapsed .actions button.report-feedback:hover:not(:disabled){background:#fff;border-color:#0284c7;color:#0869d8}
    .card.is-collapsed .actions button.primary.highlight{background:#0869d8;border-color:#0869d8;color:#fff;box-shadow:0 2px 6px rgba(8,105,216,.24)}
    .card.is-collapsed .actions button.primary.highlight:hover:not(:disabled){background:#0759c4;border-color:#0759c4;color:#fff}
    .card.is-collapsed.waiting .actions button.primary.highlight{background:#d97706;border-color:#d97706;color:#fff}
    .card.is-collapsed .expand-toggle{display:grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid rgba(14,165,233,.22);border-radius:999px;background:rgba(255,255,255,.72);color:#0369a1}
    .card.is-collapsed .expand-toggle:hover:not(:disabled){background:#fff;border-color:#0284c7;color:#0869d8}
    @media(max-width:420px){.card.is-collapsed .copy{min-width:0}}
    /* 4-segment bottom stage progress bar matching the 4 workflow stages */
    .pill-progress{position:absolute;left:12px;right:12px;bottom:2px;height:2.5px;display:grid;grid-template-columns:repeat(4,1fr);gap:4px;pointer-events:none}
    .pill-seg{position:relative;height:100%;border-radius:999px;background:rgba(8,105,216,.13);overflow:hidden}
    .pill-seg.done{background:linear-gradient(90deg,#00C4B8,#0ea5e9)}
    .pill-seg.active{background:linear-gradient(90deg,#0869d8,#0ea5e9)}
    .pill-seg.active::after{content:"";position:absolute;inset:0;width:55%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.95),transparent);animation:qzTrackFlow 1.5s ease-in-out infinite}
    /* Zone 3 (Expanded): Options, Input & Unfilled Checklist */
    .extra{display:flex;flex-direction:column;gap:8px;padding-top:9px;border-top:1px solid #f1f5f9}
    .options{display:flex;flex-wrap:wrap;gap:6px;max-height:180px;overflow-y:auto;padding-right:2px}
    .chip{padding:4px 11px;border-radius:999px;font-weight:500;background:#f8fafc;border-color:#cbd5e1;color:#1e293b}
    .chip:hover:not(:disabled){background:#eff6ff;border-color:#60a5fa;color:#0869d8}
    .chip[aria-pressed="true"]{background:#dbeafe;border-color:#0869d8;color:#0759b6;box-shadow:inset 0 0 0 1px #0869d8}
    .answer-input{width:100%;padding:7px 11px;border:1px solid #cbd5e1;border-radius:9px;font-weight:400;color:#0f172a;background:#fff}
    .unfilled-box{display:flex;flex-direction:column;gap:6px;padding-top:9px;border-top:1px solid #f1f5f9}
    .unfilled-head{display:flex;align-items:center;justify-content:space-between;font-size:11.5px;font-weight:600;color:#475569}
    .unfilled-list{display:flex;flex-direction:column;gap:6px;max-height:268px;overflow-y:auto;padding-right:2px}
    .unfilled-item{display:flex;flex-direction:column;gap:6px;padding:7px 10px;border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;transition:background .15s,border-color .15s}
    .unfilled-item:hover{border-color:#cbd5e1}
    .unfilled-item.expanded{background:#fff;border-color:#93c5fd;box-shadow:0 4px 12px rgba(8,105,216,.07)}
    .unfilled-item.resolved{background:#f0fdf4;border-color:#bbf7d0;opacity:.92}
    .item-main{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
    .unfilled-meta{display:flex;align-items:center;gap:7px;min-width:0;flex:1;cursor:pointer}
    .field-copy{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px}
    .tag{flex-shrink:0;padding:1px 6px;border-radius:5px;font-size:10.5px;font-weight:600;background:#e2e8f0;color:#475569}
    .tag.req{background:#fee2e2;color:#b91c1c}
    .tag.warn{background:#ffedd5;color:#c2410c}
    .tag.consent{background:#fef3c7;color:#b45309}
    .tag.file{background:#e0f2fe;color:#0369a1}
    .tag.ok{background:#dcfce7;color:#15803d}
    .field-name{font-size:12px;font-weight:600;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .field-reason{font-size:10.5px;color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .unfilled-item.resolved .field-reason{color:#15803d;font-weight:500}
    .item-actions{display:flex;align-items:center;gap:5px;flex-shrink:0}
    .inline-input{width:142px;padding:4px 8px;border:1px solid #cbd5e1;border-radius:7px;font-size:11.5px;font-weight:400;color:#0f172a;background:#fff;transition:border-color .15s}
    .inline-input:focus{border-color:#0869d8}
    .inline-btn{padding:4px 9px;border-radius:7px;font-size:11px;font-weight:600;background:#0869d8;border-color:#0869d8;color:#fff}
    .inline-btn:hover:not(:disabled){background:#0284c7;border-color:#0284c7}
    .inline-select{display:inline-flex;align-items:center;justify-content:space-between;gap:6px;min-width:116px;max-width:184px;padding:4px 9px;border-radius:7px;border:1px solid #cbd5e1;background:#fff;color:#1e293b;font-size:11.5px;font-weight:500}
    .inline-select:hover:not(:disabled),.inline-select[aria-expanded="true"]{border-color:#0869d8;background:#eff6ff;color:#0869d8}
    .inline-select-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .inline-select-caret{flex-shrink:0;font-size:10px;color:#64748b}
    .item-drawer{display:flex;flex-direction:column;gap:6px;padding-top:6px;border-top:1px dashed #e2e8f0}
    .drawer-crumb{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:#0369a1;background:#f0f9ff;padding:3px 8px;border-radius:6px}
    .crumb-reset{padding:1px 7px;border-radius:5px;font-size:10.5px;border-color:#bae6fd;color:#0369a1;background:#fff}
    .drawer-search-row{display:flex;gap:5px;align-items:center}
    .drawer-search{flex:1;min-width:0;padding:4px 8px;border:1px solid #cbd5e1;border-radius:7px;font-size:11.5px;font-weight:400;background:#fff;color:#0f172a}
    .drawer-chips{display:flex;flex-wrap:wrap;gap:5px;max-height:132px;overflow-y:auto;padding-right:2px}
    .drawer-chips .chip{padding:3px 9px;font-size:11.5px}
    .drawer-status{font-size:11px;color:#64748b;padding:2px 0}
    .item-error{font-size:11px;color:#dc2626;line-height:1.35}
    .mini-btn{padding:3px 8px;border-radius:7px;font-size:11px;font-weight:600}
    .mini-btn.accent{background:#0869d8;border-color:#0869d8;color:#fff}
    button.report-feedback.submitted{border-color:#86efac;background:#f0fdf4;color:#15803d}
    .feedback-box{display:flex;flex-direction:column;gap:8px;padding-top:9px;border-top:1px solid #f1f5f9}
    .feedback-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .feedback-title{font-size:12px;font-weight:650;color:#0f172a}
    .feedback-hint{font-size:11px;color:#64748b}
    .feedback-tags{display:flex;flex-wrap:wrap;gap:5px}
    .fb-tag{padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:500;background:#f8fafc;border-color:#cbd5e1;color:#1e293b}
    .fb-tag:hover:not(:disabled){background:#eff6ff;border-color:#60a5fa;color:#0869d8}
    .fb-tag[aria-pressed="true"]{background:#dbeafe;border-color:#0869d8;color:#0759b6;box-shadow:inset 0 0 0 1px #0869d8}
    .feedback-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .feedback-status{font-size:11.5px;color:#15803d;font-weight:500}
    .feedback-status.error{color:#dc2626}
    .feedback-btns{display:flex;align-items:center;gap:6px;margin-left:auto}
    .feedback-submit{background:linear-gradient(135deg,#0869d8,#0284c7);border-color:transparent;color:#fff;padding:5px 12px}
    .feedback-submit:hover:not(:disabled){filter:brightness(1.06)}
    .feedback-cancel,.feedback-copy{padding:5px 10px;font-size:11.5px}
  </style><div class="card"><div class="stage-track" aria-label="填写阶段"></div><div class="main"><div class="mark" aria-hidden="true">${markGraphic}</div><div class="copy" role="status" aria-live="polite"><span class="brand" hidden>职小搭 · 网申助手</span><div class="title-row"><span class="pill-live-dot" aria-hidden="true"></span><div class="title"></div><span class="stat-pill" hidden></span></div><div class="detail"></div></div><div class="actions"><button type="button" class="primary"></button><button type="button" class="secondary" hidden></button><button type="button" class="report-feedback" aria-expanded="false" hidden>反馈</button><button type="button" class="copy-trace" aria-live="polite" hidden>复制轨迹</button><button type="button" class="expand-toggle" aria-label="展开详情" aria-expanded="false">${chevronDown}</button></div></div><div class="extra" hidden><div class="options" hidden></div><input type="text" class="answer-input" placeholder="直接输入补充信息，按回车或点击提交…" /></div><div class="unfilled-box" hidden><div class="unfilled-head"><span class="unfilled-summary"></span><span>支持面板内直接补填 · 定位可核对网页</span></div><div class="unfilled-list"></div></div><div class="feedback-box" hidden><div class="feedback-head"><span class="feedback-title">反馈本页适配问题</span><span class="feedback-hint">仅生成脱敏诊断（页面地址与未填字段名，不含个人简历），可复制后提 Issue</span></div><div class="feedback-tags" role="group" aria-label="问题类型"></div><div class="feedback-foot"><span class="feedback-status" role="status" aria-live="polite" hidden></span><div class="feedback-btns"><button type="button" class="feedback-copy" hidden>复制诊断</button><button type="button" class="feedback-cancel">取消</button><button type="button" class="feedback-submit">生成诊断</button></div></div></div><div class="pill-progress" aria-hidden="true" hidden><span class="pill-seg"></span><span class="pill-seg"></span><span class="pill-seg"></span><span class="pill-seg"></span></div></div>`;
  const card = root.querySelector('.card') as HTMLElement;
  const stageTrack = root.querySelector('.stage-track') as HTMLElement;
  const pillProgress = root.querySelector('.pill-progress') as HTMLElement;
  const pillSegs = Array.from(root.querySelectorAll('.pill-seg')) as HTMLElement[];
  const expandToggle = root.querySelector('button.expand-toggle') as HTMLButtonElement;
  const brand = root.querySelector('.brand') as HTMLElement;
  const statPill = root.querySelector('.stat-pill') as HTMLElement;
  const title = root.querySelector('.title')!;
  const detail = root.querySelector('.detail') as HTMLElement;
  const button = root.querySelector('button.primary') as HTMLButtonElement;
  const secondaryBtn = root.querySelector('button.secondary') as HTMLButtonElement;
  const reportFeedback = root.querySelector('button.report-feedback') as HTMLButtonElement;
  const copyTrace = root.querySelector('button.copy-trace') as HTMLButtonElement;
  const extra = root.querySelector('.extra') as HTMLElement;
  const optionsBox = root.querySelector('.options') as HTMLElement;
  const answerInput = root.querySelector('.answer-input') as HTMLInputElement;
  const unfilledBox = root.querySelector('.unfilled-box') as HTMLElement;
  const unfilledSummary = root.querySelector('.unfilled-summary') as HTMLElement;
  const unfilledList = root.querySelector('.unfilled-list') as HTMLElement;
  const feedbackBox = root.querySelector('.feedback-box') as HTMLElement;
  const feedbackTags = root.querySelector('.feedback-tags') as HTMLElement;
  const feedbackStatus = root.querySelector('.feedback-status') as HTMLElement;
  const feedbackCopy = root.querySelector('button.feedback-copy') as HTMLButtonElement;
  const feedbackCancel = root.querySelector('button.feedback-cancel') as HTMLButtonElement;
  const feedbackSubmit = root.querySelector('button.feedback-submit') as HTMLButtonElement;

  const FEEDBACK_TAG_OPTIONS = ['控件填不进去', '日期/下拉选错', '漏填必填项', '字段识别错位', '其他问题'];
  const feedbackTagButtons = FEEDBACK_TAG_OPTIONS.map(label => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'fb-tag';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', 'false');
    feedbackTags.append(chip);
    return chip;
  });

  const STAGE_NAMES = ['页面扫描', '自动填写', '字段核查', '核对提交'];
  const stageNodes: { dotWrap: HTMLElement; label: HTMLElement; lineFill?: HTMLElement; lineBeam?: HTMLElement }[] = [];
  STAGE_NAMES.forEach((name, idx) => {
    const item = document.createElement('div');
    item.className = 'stage-item';
    const dotWrap = document.createElement('span');
    dotWrap.className = 'stage-dot-wrap';
    const label = document.createElement('span');
    label.className = 'stage-label';
    label.textContent = name;
    item.append(dotWrap, label);
    stageTrack.append(item);
    let lineFill: HTMLElement | undefined;
    let lineBeam: HTMLElement | undefined;
    if (idx < STAGE_NAMES.length - 1) {
      const line = document.createElement('div');
      line.className = 'stage-line';
      lineFill = document.createElement('div');
      lineFill.className = 'stage-line-fill';
      lineBeam = document.createElement('div');
      lineBeam.className = 'stage-line-beam';
      lineBeam.hidden = true;
      line.append(lineFill, lineBeam);
      stageTrack.append(line);
    }
    stageNodes.push({ dotWrap, label, lineFill, lineBeam });
  });
  const collapseChip = document.createElement('button');
  collapseChip.type = 'button';
  collapseChip.className = 'collapse-chip';
  collapseChip.setAttribute('aria-label', '收起为顶部胶囊');
  collapseChip.innerHTML = `收起 ${chevronUp}`;
  stageTrack.append(collapseChip);

  return {
    host,
    root,
    card,
    stageTrack,
    pillProgress,
    pillSegs,
    expandToggle,
    collapseChip,
    brand,
    statPill,
    title,
    detail,
    button,
    secondaryBtn,
    reportFeedback,
    copyTrace,
    extra,
    optionsBox,
    answerInput,
    unfilledBox,
    unfilledSummary,
    unfilledList,
    feedbackBox,
    feedbackTagButtons,
    feedbackStatus,
    feedbackCopy,
    feedbackCancel,
    feedbackSubmit,
    stageNodes,
  };
}
