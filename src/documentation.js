import './home.js';
import './documentation.css';
import guide from '../docs/guide.md?raw';
import highlight from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import xml from 'highlight.js/lib/languages/xml';
import bash from 'highlight.js/lib/languages/bash';

highlight.registerLanguage('javascript', javascript);
highlight.registerLanguage('xml', xml);
highlight.registerLanguage('bash', bash);

const article = document.querySelector('#doc-article');
const topicNavigation = document.querySelector('#doc-toc');
const search = document.querySelector('#doc-search');
const results = document.querySelector('#doc-results');
const topicMenu = document.querySelector('#doc-topic-menu');
const copyPage = document.querySelector('#copy-doc-page');
const copyStatus = document.querySelector('#doc-copy-status');
const desktopTopics = matchMedia('(min-width: 1051px)');
topicMenu.open = desktopTopics.matches;
desktopTopics.addEventListener('change', () => { topicMenu.open = desktopTopics.matches; });
const groups = [
  { title: 'Start here', icon: 'start', ids: ['overview', 'install', 'getting-started'] },
  { title: 'Build a scene', icon: 'cube', ids: ['parts-and-geometry', 'materials-and-color', 'renderer-reference', 'cameras-and-framing', 'effects-and-lighting'] },
  { title: 'Animate and interact', icon: 'motion', ids: ['deterministic-animation', 'assemblies-and-interaction'] },
  { title: 'Assets and media', icon: 'image', ids: ['import-and-export-models', 'images-and-films'] },
  { title: 'Reference and workflows', icon: 'book', ids: ['performance-and-memory', 'lifecycle-and-troubleshooting', 'models-and-ai-agents', 'addons-and-limits'] },
];
const iconPaths = {
  start: '<path d="m9 5 10 7-10 7V5Z"/>',
  cube: '<path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z M3 8l9 5 9-5 M12 13v8"/>',
  motion: '<path d="M5 5h14v14H5z M9 9l6 3-6 3V9Z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="16" cy="8" r="1"/>',
  book: '<path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${iconPaths[name]}</svg>`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function inline(value) {
  return escapeHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\[([^\]]+)\]\((\/[^)]+|#[^)]+)\)/g, '<a href="$2">$1</a>');
}

// Keep exact source slices for Copy page, including the Markdown heading.
const headings = [...guide.matchAll(/^## (.+)\r?$/gm)];
const topics = [
  { id: 'overview', title: 'About 67.js', raw: guide.slice(0, headings[0].index) },
  ...headings.map((heading, index) => ({
    id: heading[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, ''),
    title: heading[1].trim(),
    raw: guide.slice(heading.index, headings[index + 1]?.index ?? guide.length),
  })),
];
let currentTopic;

async function copyText(button, text, code) {
  try {
    await navigator.clipboard.writeText(text);
    button.innerHTML = `✓ ${code ? 'Copied' : 'Page copied'}`;
    copyStatus.textContent = `✓ ${code ? 'Code' : 'Page Markdown'} copied to clipboard.`;
  } catch {
    if (code) {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      copyStatus.textContent = '⚠ Clipboard unavailable. Copy the selected code.';
    } else {
      const source = document.createElement('textarea');
      source.className = 'doc-copy-fallback';
      source.readOnly = true;
      source.setAttribute('aria-label', 'Page Markdown. Select and copy this text.');
      source.value = text;
      document.querySelector('.doc-copy-fallback')?.remove();
      copyStatus.after(source);
      source.focus();
      source.select();
      copyStatus.textContent = '⚠ Clipboard unavailable. Copy the selected Markdown below.';
    }
  }
  setTimeout(() => {
    button.innerHTML = `${icon('copy')}${code ? 'Copy code' : 'Copy page'}`;
  }, 2000);
}

function codeBlock(block, title) {
  const sourceLanguage = block.match(/^```([^\n\r]*)/)[1].trim();
  const language = { js: 'javascript', javascript: 'javascript', html: 'xml', xml: 'xml', sh: 'bash', bash: 'bash' }[sourceLanguage];
  const label = { javascript: 'JavaScript', xml: 'HTML', bash: 'Shell' }[language] ?? (sourceLanguage || 'Plain text');
  const source = block.replace(/^```[^\n]*\n/, '').replace(/```\s*$/, '').trimEnd();
  const container = document.createElement('div');
  container.className = 'code-block';
  const header = document.createElement('div');
  header.className = 'code-header';
  const languageLabel = document.createElement('span');
  languageLabel.className = 'code-language';
  languageLabel.textContent = label;
  const button = document.createElement('button');
  button.className = 'copy-code';
  button.innerHTML = `${icon('copy')}Copy code`;
  button.setAttribute('aria-label', `Copy ${label} code from ${title}`);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = language ? `hljs language-${language}` : 'hljs';
  code.innerHTML = language ? highlight.highlight(source, { language }).value : escapeHtml(source);
  button.addEventListener('click', () => copyText(button, source, code));
  header.append(languageLabel, button);
  pre.append(code);
  container.append(header, pre);
  return container;
}

function renderParagraph(paragraph, section) {
  if (paragraph.startsWith('|')) {
    const table = document.createElement('table');
    const rows = paragraph.split('\n').filter(row => !/^\|[\s:|-]+\|$/.test(row));
    table.innerHTML = rows.map((row, rowIndex) => `<tr>${row.split('|').slice(1, -1).map(cell => `<${rowIndex ? 'td' : 'th'}>${inline(cell.trim())}</${rowIndex ? 'td' : 'th'}>`).join('')}</tr>`).join('');
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    scroll.append(table);
    section.append(scroll);
  } else if (/^\d+\.\s/.test(paragraph)) {
    const list = document.createElement('ol');
    for (const line of paragraph.split('\n')) {
      const item = document.createElement('li');
      item.innerHTML = inline(line.replace(/^\d+\.\s/, ''));
      list.append(item);
    }
    section.append(list);
  } else {
    const element = document.createElement('p');
    element.innerHTML = inline(paragraph);
    section.append(element);
  }
}

function renderNavigation() {
  const words = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matching = topics.filter(topic => words.every(word => topic.raw.toLowerCase().includes(word) || topic.title.toLowerCase().includes(word)));
  topicNavigation.replaceChildren();
  for (const group of groups) {
    const members = matching.filter(topic => group.ids.includes(topic.id));
    if (!members.length) continue;
    const region = document.createElement('div');
    region.className = 'doc-topic-group';
    const heading = document.createElement('h2');
    heading.innerHTML = `${icon(group.icon)}${escapeHtml(group.title)}`;
    region.append(heading);
    for (const topic of members) {
      const link = document.createElement('a');
      link.href = `#${topic.id}`;
      link.textContent = topic.title;
      if (topic === currentTopic) link.setAttribute('aria-current', 'page');
      link.addEventListener('click', () => {
        if (!desktopTopics.matches) topicMenu.open = false;
        if (location.hash === link.hash) article.focus();
      });
      region.append(link);
    }
    topicNavigation.append(region);
  }
  results.textContent = words.length ? matching.length ? `${matching.length} ${matching.length === 1 ? 'topic' : 'topics'} found` : '⌕ No matching topics. Try camera, memory, or agents.' : '';
}

function openTopic(focus = false) {
  const requested = location.hash.slice(1);
  currentTopic = topics.find(topic => topic.id === requested) ?? topics.find(topic => topic.id === 'install');
  if (requested !== currentTopic.id) history.replaceState(null, '', `#${currentTopic.id}`);
  const section = document.createElement('section');
  section.id = currentTopic.id;
  const heading = document.createElement('h1');
  heading.textContent = currentTopic.title;
  section.append(heading);
  const content = currentTopic.raw.replace(/^#{1,2} [^\n]*\n/, '').trim().replace(/\r\n/g, '\n');
  const blocks = content.split(/(```[^\n]*\n[\s\S]*?```)/g);
  for (const block of blocks) {
    if (block.startsWith('```')) {
      section.append(codeBlock(block, currentTopic.title));
    } else {
      for (const paragraph of block.trim().split(/\n\s*\n/)) {
        if (paragraph.trim()) renderParagraph(paragraph, section);
      }
    }
  }
  article.replaceChildren(section);
  if (currentTopic.id === 'install') {
    const managerLink = document.createElement('p');
    managerLink.innerHTML = `<a href="/#downloads">Choose a package manager and get the current release ${icon('arrow')}</a>`;
    section.append(managerLink);
  }
  const index = topics.indexOf(currentTopic);
  const pagination = document.createElement('nav');
  pagination.className = 'doc-pagination';
  pagination.setAttribute('aria-label', 'Adjacent topics');
  for (const [topic, direction] of [[topics[index - 1], 'Previous'], [topics[index + 1], 'Next']]) {
    if (!topic) continue;
    const link = document.createElement('a');
    link.href = `#${topic.id}`;
    link.innerHTML = `<span>${direction}</span><strong>${escapeHtml(topic.title)} ${direction === 'Next' ? icon('arrow') : ''}</strong>`;
    pagination.append(link);
  }
  article.append(pagination);
  document.querySelector('#doc-topic-name').textContent = currentTopic.title;
  document.title = `${currentTopic.title} · 67.js documentation`;
  copyStatus.textContent = '';
  document.querySelector('.doc-copy-fallback')?.remove();
  copyPage.innerHTML = `${icon('copy')}Copy page`;
  renderNavigation();
  if (focus) {
    article.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }
}

copyPage.innerHTML = `${icon('copy')}Copy page`;
document.querySelector('#doc-topic-menu summary > :last-child').innerHTML = icon('chevron');
copyPage.addEventListener('click', () => copyText(copyPage, currentTopic.raw));
search.addEventListener('input', () => {
  if (search.value.trim()) topicMenu.open = true;
  renderNavigation();
});
window.addEventListener('hashchange', () => openTopic(true));
openTopic();
