import './home.js';
import guide from '../docs/guide.md?raw';

const article = document.querySelector('#doc-article');
const toc = document.querySelector('#doc-toc');
const escape = value => value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
// The source is maintained in this repository, not user-supplied Markdown.
function inline(value) {
  return escape(value).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\((\/[^)]+)\)/g,'<a href="$2">$1</a>');
}
const sections = guide.split(/^## /m).slice(1).map((text, index) => {
  const [title, ...lines] = text.split('\n');
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'');
  const section = document.createElement('section');
  section.id = id;
  section.innerHTML = `<h2>${escape(title)}</h2>`;
  const blocks = lines.join('\n').trim().split(/(```[^\n]*\n[\s\S]*?```)/g);
  for (const block of blocks) {
    if (block.startsWith('```')) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = block.replace(/^```[^\n]*\n/, '').replace(/```$/, '').trimEnd();
      pre.append(code);
      const button = document.createElement('button');
      button.className = 'copy-code';
      button.textContent = 'Copy';
      button.setAttribute('aria-label', `Copy code from ${title}`);
      button.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(code.textContent); button.textContent = 'Copied'; }
        catch { button.textContent = 'Select and copy'; const selection = getSelection(); const range = document.createRange(); range.selectNodeContents(code); selection.removeAllRanges(); selection.addRange(range); }
        setTimeout(() => { button.textContent = 'Copy'; }, 2000);
      });
      pre.append(button);
      section.append(pre);
    } else {
      for (const paragraph of block.trim().split(/\n\s*\n/)) {
        if (!paragraph.trim()) continue;
        if (paragraph.startsWith('|')) {
          const table = document.createElement('table');
          const rows = paragraph.split('\n').filter(row => !/^\|[\s:|-]+\|$/.test(row));
          table.innerHTML = rows.map((row, rowIndex) => `<tr>${row.split('|').slice(1,-1).map(cell => `<${rowIndex ? 'td' : 'th'}>${inline(cell.trim())}</${rowIndex ? 'td' : 'th'}>`).join('')}</tr>`).join('');
          const scroll = document.createElement('div'); scroll.className = 'table-scroll'; scroll.append(table); section.append(scroll);
        } else if (/^\d+\.\s/.test(paragraph)) {
          const list = document.createElement('ol');
          for (const line of paragraph.split('\n')) {
            const item = document.createElement('li');
            item.innerHTML = inline(line.replace(/^\d+\.\s/, ''));
            list.append(item);
          }
          section.append(list);
        } else {
          const p = document.createElement('p'); p.innerHTML = inline(paragraph); section.append(p);
        }
      }
    }
  }
  const link = document.createElement('a'); link.href = `#${id}`; link.textContent = title;
  toc.append(link); article.append(section);
  return { section, link, text: text.toLowerCase(), index };
});

if (location.hash) {
  document.getElementById(location.hash.slice(1))?.scrollIntoView();
}
document.querySelector('#doc-search').addEventListener('input', event => {
  const words = event.target.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  let count = 0;
  for (const item of sections) {
    const visible = words.every(word => item.text.includes(word));
    item.section.hidden = item.link.hidden = !visible;
    if (visible) count++;
  }
  document.querySelector('#doc-results').textContent = words.length ? count ? `${count} topics found` : 'No matching topics. Try “camera”, “memory” or “agents”.' : '';
});
