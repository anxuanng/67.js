import './home.css';
import './brand.js';

const state = { status: 'loading', release: null };

function setText(selector, text) {
  document.querySelectorAll(selector).forEach(element => { element.textContent = text; });
}

function releaseURL(value) {
  const url = new URL(value, location.href);
  if (url.origin !== location.origin || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Release files must use the current site.');
  }
  return url.href;
}

function validateRelease(release) {
  for (const key of ['version', 'packageName', 'commit', 'installCommand', 'tarball', 'module', 'api']) {
    if (typeof release[key] !== 'string' || !release[key].trim()) throw new Error(`Missing release field: ${key}`);
  }
  if (typeof release.registryPublished !== 'boolean') throw new Error('Missing publication status.');
  if (!/^[a-f0-9]{7,40}$/i.test(release.commit)) throw new Error('Invalid release commit.');
  releaseURL(release.tarball);
  releaseURL(release.module);
  releaseURL(release.api);
  return release;
}

function setLink(selector, url, download = false) {
  document.querySelectorAll(selector).forEach(link => {
    if (url) {
      link.href = url;
      link.removeAttribute('aria-disabled');
      if (download) link.setAttribute('download', '');
    } else {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
    }
  });
}

function renderRelease() {
  const release = state.release;
  document.querySelectorAll('[data-copy-install]').forEach(button => { button.disabled = !release; });
  document.querySelectorAll('[data-release-retry]').forEach(button => { button.hidden = state.status !== 'error'; });
  document.querySelectorAll('[data-release-status]').forEach(element => { element.dataset.status = state.status; });
  setText('[data-release-version]', release ? `v${release.version}` : state.status === 'error' ? 'Release unavailable' : 'Loading release');
  setText('[data-install-command]', release ? release.installCommand : state.status === 'error' ? 'Release information is unavailable' : 'Loading the release command…');
  setText('[data-release-status]', release
    ? release.registryPublished ? '✓ Install the current published release' : '✓ Install this release from the package archive'
    : state.status === 'error' ? '⚠ Release information could not load. Retry to get the current files' : '◷ Loading release information');
  setLink('[data-release-tarball]', release ? releaseURL(release.tarball) : null, true);
  setLink('[data-release-module]', release ? releaseURL(release.module) : null, true);
  setLink('[data-release-api]', release ? releaseURL(release.api) : null);
  setLink('[data-release-commit]', release ? `https://github.com/anxuanng/67.js/commit/${release.commit}` : null);
  setText('[data-release-commit]', release ? `Commit ${release.commit.slice(0, 7)}` : 'Release commit');
  if (release && document.querySelector('#browser-code')) {
    const cubeCode = document.querySelector('#cube-code').textContent.replace("from '67js'", `from '${releaseURL(release.module)}'`);
    document.querySelector('#browser-code').textContent = `<canvas id="scene" style="width:100vw;height:100vh;display:block"></canvas>\n<script type="module">\n${cubeCode}\n</script>`;
  } else if (document.querySelector('#browser-code')) {
    document.querySelector('#browser-code').textContent = state.status === 'error'
      ? 'Release information is unavailable. Use Retry above to load the browser example.'
      : 'The browser example appears when the current release loads.';
  }
}

async function loadRelease() {
  state.status = 'loading';
  state.release = null;
  renderRelease();
  try {
    const response = await fetch('./release.json', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Release endpoint returned ${response.status}.`);
    state.release = validateRelease(await response.json());
    state.status = 'ready';
  } catch {
    state.status = 'error';
  }
  renderRelease();
}

function selectCommand() {
  const element = document.querySelector('[data-install-command]');
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

document.querySelectorAll('[data-copy-install]').forEach(button => {
  button.addEventListener('click', async () => {
    if (!state.release) return;
    try {
      await navigator.clipboard.writeText(state.release.installCommand);
      setText('[data-release-status]', '✓ Install command copied');
    } catch {
      selectCommand();
      setText('[data-release-status]', '⚠ Clipboard unavailable. Copy the selected command');
    }
  });
});
document.querySelectorAll('[data-release-retry]').forEach(button => button.addEventListener('click', loadRelease));
document.querySelectorAll('.example img').forEach(image => {
  image.addEventListener('error', () => {
    image.alt = `${image.alt}. Preview unavailable. Open the example to explore it`;
  }, { once: true });
});
window.__home = { state, loadRelease };
loadRelease();
window.addEventListener('pageshow', event => { if (event.persisted) loadRelease(); });
