// A soft light under the pointer. The position goes into two custom properties on <html>, at most once per frame.
// Touch screens and reduced motion get none.
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

if (finePointer.matches && !reducedMotion.matches) {
  const root = document.documentElement;
  const light = document.createElement('div');
  light.className = 'pointer-light';
  light.setAttribute('aria-hidden', 'true');
  document.body.append(light);

  let pendingFrame = 0;
  let latestX = 0;
  let latestY = 0;

  const paint = () => {
    pendingFrame = 0;
    root.style.setProperty('--pointer-x', `${latestX}px`);
    root.style.setProperty('--pointer-y', `${latestY}px`);
  };

  window.addEventListener('pointermove', event => {
    latestX = event.clientX;
    latestY = event.clientY;
    if (!pendingFrame) pendingFrame = requestAnimationFrame(paint);
  }, { passive: true });
}
