import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Button, CopyIcon, CheckIcon } from '@codepawlhq/orglet-ui';

// React owns the controls; the surrounding website remains plain HTML.
export function mountButton(element, options = {}) {
  const attributes = {};
  for (const { name, value } of element.attributes) {
    if (name === 'id' || name.startsWith('data-') || name.startsWith('aria-')) attributes[name] = value;
  }
  const slot = document.createElement('span');
  slot.className = 'oui-control';
  element.replaceWith(slot);
  const root = createRoot(slot);
  let properties = { ...attributes, className:`oui-action ${element.className}`, disabled:element.disabled, label:element.textContent.trim(), ...options };
  function update(changes = {}) {
    properties = { ...properties, ...changes };
    const { label, icon, ...props } = properties;
    const glyph = icon === 'copy' ? createElement(CopyIcon) : icon === 'check' ? createElement(CheckIcon) : icon;
    flushSync(() => root.render(createElement(Button, { type:'button', ...props }, glyph, createElement('span', null, label))));
  }
  update();
  return { update };
}

export function packageLogo(name) {
  return createElement('span', { className:`package-logo package-logo-${name}`, 'aria-hidden':true });
}
