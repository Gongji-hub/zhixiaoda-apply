import type { FeedbackState } from '../feedbackOverlay';

export const VIEWPORT_GLOW_ID = 'qz-agent-viewport-glow';

const VIEWPORT_GLOW_CSS = `
@keyframes qzGlowA{0%,100%{opacity:.40}50%{opacity:.94}}
@keyframes qzGlowB{0%,100%{opacity:.88}50%{opacity:.32}}
@keyframes qzGlowWaitA{0%,100%{opacity:.38}50%{opacity:.95}}
@keyframes qzGlowWaitB{0%,100%{opacity:.85}50%{opacity:.30}}
@keyframes qzSheenH{0%{transform:translateX(-110%);opacity:0}18%{opacity:.88}82%{opacity:.88}100%{transform:translateX(110%);opacity:0}}
@keyframes qzSheenV{0%{transform:translateY(-110%);opacity:0}18%{opacity:.76}82%{opacity:.76}100%{transform:translateY(110%);opacity:0}}
#${VIEWPORT_GLOW_ID}{all:initial!important;position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;overflow:hidden!important;contain:strict!important;transition:opacity .55s cubic-bezier(.22,1,.36,1)!important}
#${VIEWPORT_GLOW_ID}[data-mode="done"],#${VIEWPORT_GLOW_ID}[data-mode="connect"]{opacity:0!important}
#${VIEWPORT_GLOW_ID} > div{position:absolute!important;pointer-events:none!important;box-sizing:border-box!important}
#${VIEWPORT_GLOW_ID} .qz-gl-a,#${VIEWPORT_GLOW_ID} .qz-gl-b{inset:0!important;will-change:opacity;transition:opacity .35s ease}
/* Misty ocean/sky-blue 4-edge ambient feather (avoids fluorescent turquoise hard bands). */
#${VIEWPORT_GLOW_ID}[data-mode="running"] .qz-gl-a{
  box-shadow:inset 0 0 0 1.5px rgba(56,189,248,.42),inset 0 14px 48px -8px rgba(8,105,216,.30),inset 16px 0 48px -8px rgba(14,132,226,.24),inset -16px 0 48px -8px rgba(14,165,233,.20),inset 0 -16px 48px -8px rgba(14,165,233,.22);
  background:radial-gradient(ellipse 52% 11% at 28% 0%,rgba(14,165,233,.16),transparent 74%),radial-gradient(ellipse 46% 10% at 74% 100%,rgba(56,189,248,.13),transparent 74%);
  animation:qzGlowA 4.4s cubic-bezier(.4,0,.2,1) infinite;
}
#${VIEWPORT_GLOW_ID}[data-mode="running"] .qz-gl-b{
  box-shadow:inset 0 0 0 1.5px rgba(14,165,233,.36),inset 0 12px 46px -8px rgba(14,165,233,.24),inset -16px 0 50px -8px rgba(6,182,212,.21),inset 0 -16px 50px -8px rgba(8,105,216,.24),inset 16px 0 46px -8px rgba(56,189,248,.19);
  background:radial-gradient(ellipse 52% 11% at 72% 0%,rgba(56,189,248,.15),transparent 74%),radial-gradient(ellipse 46% 10% at 26% 100%,rgba(8,105,216,.13),transparent 74%);
  animation:qzGlowB 4.4s cubic-bezier(.4,0,.2,1) infinite;
}
#${VIEWPORT_GLOW_ID}[data-mode="waiting"] .qz-gl-a{
  box-shadow:inset 0 0 0 1.5px rgba(245,158,11,.50),inset 0 14px 48px -8px rgba(217,119,6,.32),inset 16px 0 48px -8px rgba(245,158,11,.26),inset -16px 0 48px -8px rgba(234,88,12,.22),inset 0 -16px 48px -8px rgba(245,158,11,.24);
  background:radial-gradient(ellipse 50% 11% at 50% 0%,rgba(245,158,11,.15),transparent 74%);
  animation:qzGlowWaitA 3.0s cubic-bezier(.4,0,.2,1) infinite;
}
#${VIEWPORT_GLOW_ID}[data-mode="waiting"] .qz-gl-b{
  box-shadow:inset 0 0 0 1.5px rgba(217,119,6,.42),inset -16px 0 48px -8px rgba(217,119,6,.24),inset 0 -16px 48px -8px rgba(234,88,12,.22);
  animation:qzGlowWaitB 3.0s cubic-bezier(.4,0,.2,1) infinite;
}
#${VIEWPORT_GLOW_ID}[data-mode="paused"] .qz-gl-a{
  box-shadow:inset 0 0 0 1.5px rgba(100,116,139,.28),inset 0 0 26px rgba(71,85,105,.14);
  opacity:.76;animation:none;
}
#${VIEWPORT_GLOW_ID}[data-mode="paused"] .qz-gl-b{opacity:0;animation:none}
#${VIEWPORT_GLOW_ID} .qz-sh{opacity:0;will-change:transform,opacity}
#${VIEWPORT_GLOW_ID}[data-mode="running"] .qz-sh-t{top:0!important;left:0!important;right:0!important;height:2px!important;background:linear-gradient(90deg,transparent,rgba(56,189,248,.48) 26%,rgba(255,255,255,.92) 50%,rgba(14,165,233,.5) 74%,transparent);box-shadow:0 0 10px rgba(56,189,248,.42);animation:qzSheenH 5.4s cubic-bezier(.4,0,.2,1) infinite}
#${VIEWPORT_GLOW_ID}[data-mode="running"] .qz-sh-b{bottom:0!important;left:0!important;right:0!important;height:2px!important;background:linear-gradient(90deg,transparent,rgba(14,165,233,.42) 26%,rgba(224,242,254,.9) 50%,rgba(8,105,216,.46) 74%,transparent);animation:qzSheenH 5.4s cubic-bezier(.4,0,.2,1) -2.7s infinite reverse}
#${VIEWPORT_GLOW_ID}[data-mode="running"] .qz-sh-l{top:0!important;bottom:0!important;left:0!important;width:2px!important;background:linear-gradient(180deg,transparent,rgba(8,105,216,.36) 28%,rgba(224,242,254,.86) 50%,rgba(14,165,233,.36) 72%,transparent);animation:qzSheenV 6.0s cubic-bezier(.4,0,.2,1) -1.4s infinite}
#${VIEWPORT_GLOW_ID}[data-mode="running"] .qz-sh-r{top:0!important;bottom:0!important;right:0!important;width:2px!important;background:linear-gradient(180deg,transparent,rgba(14,165,233,.36) 28%,rgba(224,242,254,.86) 50%,rgba(56,189,248,.36) 72%,transparent);animation:qzSheenV 6.0s cubic-bezier(.4,0,.2,1) -4.2s infinite reverse}
#${VIEWPORT_GLOW_ID}[data-mode="waiting"] .qz-sh-t{top:0!important;left:0!important;right:0!important;height:2px!important;background:linear-gradient(90deg,transparent,rgba(251,191,36,.52) 26%,rgba(255,251,235,.95) 50%,rgba(217,119,6,.5) 74%,transparent);animation:qzSheenH 3.6s cubic-bezier(.4,0,.2,1) infinite}
@media(prefers-reduced-motion:reduce){#${VIEWPORT_GLOW_ID} *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
`;

/** Independent pointer-events:none viewport breathing light; kept separate from #qz-agent-feedback so field/popup viewport bounds stay exact. */
export function syncViewportGlow(mode: FeedbackState['mode']) {
  let el = document.getElementById(VIEWPORT_GLOW_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = VIEWPORT_GLOW_ID;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<style>${VIEWPORT_GLOW_CSS}</style><div class="qz-gl-a"></div><div class="qz-gl-b"></div><div class="qz-sh qz-sh-t"></div><div class="qz-sh qz-sh-b"></div><div class="qz-sh qz-sh-l"></div><div class="qz-sh qz-sh-r"></div>`;
    document.documentElement.append(el);
  }
  el.setAttribute('data-mode', mode);
}

export function removeViewportGlow() {
  document.getElementById(VIEWPORT_GLOW_ID)?.remove();
}
