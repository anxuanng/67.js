import highlight from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import xml from 'highlight.js/lib/languages/xml';

// highlight.js's bash grammar leaves a plain command such as `npm install pkg` uncoloured, so the site's commands get a
// small grammar of their own: the program, its subcommand, flags, numbers and package specifiers.
function shell() {
  return {
    name: 'Shell',
    contains: [
      { className: 'comment', begin: /#/, end: /$/ },
      { className: 'built_in', begin: /^\s*[\w.-]+/, starts: { end: /$/, returnEnd: true, contains: [
        { className: 'keyword', begin: /(?<=^\s*[\w.-]+\s+)\w[\w-]*/ },
        { className: 'attr', begin: /\s--?[\w-]+/ },
        { className: 'string', begin: /'/, end: /'/ },
        { className: 'string', begin: /"/, end: /"/ },
        { className: 'string', begin: /[\w.-]*@[\w@/.:^~-]+/ },
        { className: 'number', begin: /\b\d+(\.\d+)*\b/ },
      ] } },
    ],
  };
}

highlight.registerLanguage('javascript', javascript);
highlight.registerLanguage('xml', xml);
highlight.registerLanguage('shell', shell);
highlight.registerAliases(['bash', 'sh'], { languageName: 'shell' });

/** Return highlighted HTML for source in a registered language. */
export function highlightCode(source, language) {
  return highlight.highlight(source, { language }).value;
}

/** Colour a code element's own text in place. */
export function highlightElement(element, language) {
  element.innerHTML = highlightCode(element.textContent, language);
  element.classList.add('hljs', `language-${language}`);
}
