const svgNamespace = 'http://www.w3.org/2000/svg';

function createStrokeIcon(shapes) {
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS(svgNamespace, tag);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.append(shape);
  }
  return svg;
}

const iconShapes = {
  copy: () => createStrokeIcon([
    ['rect', { x: 6.5, y: 6.5, width: 10, height: 10, rx: 2 }],
    ['path', { d: 'M13.5 6.5v-1.5a1.5 1.5 0 0 0-1.5-1.5h-6.5a1.5 1.5 0 0 0-1.5 1.5v6.5a1.5 1.5 0 0 0 1.5 1.5h1.5' }],
  ]),
  check: () => createStrokeIcon([
    ['path', { d: 'M4.5 10.5l3.5 3.5 7.5-8' }],
  ]),
};

// Turns an existing <button> in the page into a site button and returns an `update` function
// for its label, icon and attributes. The surrounding website stays plain HTML.
export function mountButton(button, options = {}) {
  button.classList.add('site-button');
  button.type = 'button';
  let state = { label: button.textContent.trim(), ...options };

  function applyAttribute(name, value) {
    if (name === 'hidden' || name === 'disabled') button[name] = Boolean(value);
    else button.setAttribute(name, String(value));
  }

  function update(changes = {}) {
    state = { ...state, ...changes };
    const { label, icon, onClick, ...attributes } = state;
    for (const [name, value] of Object.entries(attributes)) applyAttribute(name, value);

    const glyph = typeof icon === 'string' ? iconShapes[icon]?.() : icon;
    const text = document.createElement('span');
    text.textContent = label;
    button.replaceChildren(...(glyph ? [glyph, text] : [text]));
  }

  button.addEventListener('click', event => state.onClick?.(event));
  update();
  return { update };
}

export function packageLogo(name) {
  const logo = document.createElement('span');
  logo.className = `package-logo package-logo-${name}`;
  logo.setAttribute('aria-hidden', 'true');
  return logo;
}
