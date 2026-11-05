(() => {
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const active = new WeakMap();
  const runningAnimations = new Set();
  const timers = new WeakMap();
  const ease = 'cubic-bezier(.22,.72,.2,1)';
  function animate(node, frames, options = {}, fallback = 'motion-enter') {
    if (!node || preference.matches || node.closest('[hidden]')) return;
    const previous = active.get(node); previous?.cancel();
    if (typeof node.animate !== 'function') {
      node.classList.remove(fallback);
      clearTimeout(timers.get(node));
      void node.offsetWidth;
      node.classList.add(fallback);
      timers.set(node, setTimeout(() => node.classList.remove(fallback), 320));
      return;
    }
    const animation = node.animate(frames, { duration: 220, easing: ease, ...options });
    active.set(node, animation); runningAnimations.add(animation);
    const cleanup = () => { runningAnimations.delete(animation); if (active.get(node) === animation) active.delete(node); };
    animation.finished.then(cleanup, cleanup);
  }
  function enter(node, delay = 0) {
    animate(node, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], { delay, duration: 240 });
  }
  function resize(node, fromHeight) {
    if (!node || preference.matches) return;
    active.get(node)?.cancel();
    const height = node.getBoundingClientRect().height;
    if (Math.abs(height - fromHeight) > 1) animate(node, [{ height: `${fromHeight}px` }, { height: `${height}px` }], { duration: 260 });
  }
  function update(node) {
    animate(node, [{ opacity: .35, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180 }, 'motion-update');
  }
  function flash(node) {
    animate(node, [{ backgroundColor: '#eaf3ff' }, { backgroundColor: 'transparent' }], { duration: 440 }, 'motion-flash');
  }
  function captureRows(nodes) {
    if (preference.matches) return new Map();
    const positions = new Map();
    for (const node of Array.from(nodes).slice(0, 32)) {
      const rect = node.getBoundingClientRect();
      if (rect.height && rect.bottom > 0 && rect.top < innerHeight) positions.set(node, rect);
    }
    return positions;
  }
  function moveRows(positions) {
    if (preference.matches) return;
    for (const [node, previous] of positions) {
      if (!node.isConnected) continue;
      active.get(node)?.cancel();
      const current = node.getBoundingClientRect();
      if (!current.height || current.top > innerHeight || current.bottom < 0) continue;
      const delta = previous.top - current.top;
      if (Math.abs(delta) > 1) animate(node, [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: 240 });
    }
  }
  preference.addEventListener('change', () => {
    if (preference.matches) { for (const animation of runningAnimations) animation.cancel(); runningAnimations.clear(); }
  });
  globalThis.JobPanelMotion = { enter, resize, update, flash, captureRows, moveRows };
})();
