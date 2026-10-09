const preference = matchMedia('(prefers-reduced-motion: reduce)');
const animations = new Set();
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer.unobserve(entry.target);
    if (preference.matches) continue;
    const animation = entry.target.animate([
      { opacity:0.5, transform:'translateY(14px)' },
      { opacity:1, transform:'translateY(0)' },
    ], { duration:420, easing:'cubic-bezier(.2,0,0,1)' });
    animations.add(animation);
    animation.finished.catch(() => {}).finally(() => animations.delete(animation));
  }
}, { threshold:0.08 });

// Content stays visible without JavaScript; only sections below the fold reveal.
for (const element of document.querySelectorAll('.workflow > div, .example, .site-footer')) {
  if (!preference.matches && element.getBoundingClientRect().top >= innerHeight) observer.observe(element);
}
function stop() {
  observer.disconnect();
  for (const animation of animations) animation.cancel();
  animations.clear();
}
preference.addEventListener('change', () => { if (preference.matches) stop(); });
window.addEventListener('pagehide', stop);
