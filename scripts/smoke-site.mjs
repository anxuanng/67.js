import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
await import('./smoke-navigation.mjs');
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true, args:['--enable-webgl','--ignore-gpu-blocklist'] });
const errors = [];
const report = { layouts: [], interactions: [] };
try {
  const page = await browser.newPage({ viewport:{ width:1440,height:1000 }, colorScheme:'dark', reducedMotion:'reduce' });
  await page.addInitScript(() => {
    window.__copiedText = '';
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async text => { window.__copiedText = text; } },
    });
  });
  page.on('pageerror', error => errors.push(error.message));
  for (const route of ['/', '/downloads.html', '/docs.html', '/getting-started.html', '/object.html', '/motion.html', '/nature.html', '/assets.html', '/view2d.html', '/film.html']) {
    await page.goto(origin + route);
    if (route.includes('object')) await page.waitForFunction(() => window.__studio?.renderer);
    if (route.includes('motion')) await page.waitForFunction(() => window.__motion?.renderer);
    if (route.includes('nature')) await page.waitForFunction(() => window.__nature?.renderer);
    if (route.includes('assets')) await page.waitForFunction(() => window.__assetViewer?.renderer);
    if (route.includes('film')) await page.waitForFunction(() => window.__filmReady);
    for (const width of [1440,390,320]) {
      await page.setViewportSize({ width,height:1000 });
      await page.waitForTimeout(150);
      if (route === '/') {
        await page.locator('img').evaluateAll(images => images.forEach(image => { image.loading = 'eager'; }));
        await page.waitForFunction(() => [...document.images].every(image => image.complete));
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(overflow,false,`${route} overflow at ${width}`);
      const clippedLinks = await page.locator('nav a').evaluateAll(links => links.filter(link => {
        const rectangle = link.getBoundingClientRect();
        return rectangle.width && (rectangle.left < -1 || rectangle.right > innerWidth + 1);
      }).map(link => link.textContent));
      assert.deepEqual(clippedLinks,[],`${route} clipped navigation at ${width}`);
      if (['/object.html','/nature.html'].includes(route) && width < 700) {
        const geometry = await page.evaluate(() => ({ canvas:document.querySelector('#viewport').getBoundingClientRect().toJSON(), controls:document.querySelector('.controls, .landscape-controls').getBoundingClientRect().toJSON(), title:document.querySelector('.object-info, .landscape-title').getBoundingClientRect().toJSON() }));
        assert.ok(geometry.canvas.bottom <= geometry.controls.top, 'Mobile controls overlap the model');
        assert.ok(geometry.title.bottom <= geometry.canvas.top, 'Mobile title overlaps the model');
      }
      await page.screenshot({ path:`artifacts/site-${route.replace(/[^a-z]/g,'') || 'home'}-${width}.png`, fullPage:true });
      report.layouts.push({ route,width,overflow });
    }
    await page.setViewportSize({ width:1440,height:1000 });
    if (['/', '/downloads.html', '/docs.html', '/getting-started.html'].includes(route)) {
      assert.equal(await page.locator('aside.navigation').count(), 0);
      assert.deepEqual(await page.locator('.navigation nav .nav-label').allTextContents(), ['Downloads', 'Docs']);
      assert.equal(await page.locator('.navigation nav a[aria-current="page"]').count(), route === '/' ? 0 : 1);
      assert.equal(await page.locator('a[href$="llms.txt"]').count(), 0, 'Machine guide appears in public UI');
      assert.equal(await page.locator('.navigation a[href*="getting-started.html"]').count(), 0, 'Getting started still has separate navigation');
    }
    if (route === '/') {
      assert.equal(await page.locator('video').count(), 0, 'Homepage still embeds video');
      assert.equal(await page.locator('#downloads').count(), 0, 'Downloads still merged into Showcase');
      const scenePaths = await page.locator('.gallery .example').evaluateAll(links => links.map(link => new URL(link.href).pathname));
      assert.equal(new Set(scenePaths).size, scenePaths.length, 'Showcase repeats the same scene');
      await page.locator('#home-preview').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => window.__homePreview?.renderer && window.__homePreview.state.visible);
      const initialDistance = await page.evaluate(() => window.__homePreview.state.distance);
      await page.locator('#home-preview').focus();
      await page.keyboard.press('+');
      assert.ok(await page.evaluate(() => window.__homePreview.state.distance) < initialDistance);
      await page.locator('#home-preview').focus();
      await page.keyboard.press('ArrowRight');
      assert.ok(await page.evaluate(() => window.__homePreview.state.yaw) > 0.6);
      await page.keyboard.press('Home');
      assert.equal(await page.evaluate(() => window.__homePreview.state.yaw), 0.6);
      assert.equal(await page.locator('.preview-tools, .showcase-caption').count(), 0);
      assert.equal(await page.evaluate(() => window.__homePreview.state.playing), false);
      await page.emulateMedia({ reducedMotion:'no-preference' });
      await page.waitForFunction(() => window.__homePreview.state.time > 0.1);
      await page.locator('#preview-assembly').evaluate(slider => {
        slider.value = '100';
        slider.dispatchEvent(new Event('input', { bubbles:true }));
        slider.dispatchEvent(new Event('change', { bubbles:true }));
      });
      assert.equal(await page.evaluate(() => window.__homePreview.state.assembly), 1);
      assert.equal(await page.evaluate(() => window.__homePreview.state.playing), false);
      const frozenTime = await page.evaluate(() => window.__homePreview.state.time);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.__homePreview.state.time), frozenTime);
      await page.locator('#home-preview').focus();
      await page.keyboard.press('Space');
      assert.equal(await page.evaluate(() => window.__homePreview.state.playing), false, 'Exploded model resumes from Space');
      await page.locator('#preview-assembly').evaluate(slider => {
        slider.value = '0';
        slider.dispatchEvent(new Event('input', { bubbles:true }));
        slider.dispatchEvent(new Event('change', { bubbles:true }));
      });
      assert.equal(await page.evaluate(() => window.__homePreview.state.playing), true);
      assert.ok(await page.evaluate(() => window.__homePreview.state.speed) < 0.4, 'Drive restarts at full speed');
      await page.waitForFunction(() => window.__homePreview.state.speed === 1);
      await page.emulateMedia({ reducedMotion:'reduce' });
      await page.waitForFunction(() => !window.__homePreview.state.playing);
      assert.equal(await page.evaluate(() => window.__homePreview.state.playing), false);
      const backgroundAlpha = await page.evaluate(() => {
        window.__homePreview.draw();
        const context = window.__homePreview.renderer.context;
        const pixel = new Uint8Array(4);
        context.readPixels(0, 0, 1, 1, context.RGBA, context.UNSIGNED_BYTE, pixel);
        return pixel[3];
      });
      assert.equal(backgroundAlpha, 0, 'Preview background is opaque');
      assert.equal(await page.evaluate(() => window.__homePreview.renderer.context.getError()), 0);
      assert.ok(await page.evaluate(() => window.__homePreview.renderer.memoryPlan.estimatedBytes) <= 192 * 1048576);
      await page.screenshot({ path:'artifacts/home-live-preview.png' });
      report.interactions.push('Live WALL·E, keyboard orbit, transparent render and paused assembly with gradual drive restart');
    }
    if (route === '/downloads.html') {
      await page.waitForFunction(() => window.__home.state.status === 'ready');
      assert.equal(await page.locator('.package-managers .package-logo').count(), 4);
      assert.equal(await page.locator('[data-package-manager]').count(), 4);
      assert.equal(await page.locator('[data-release-tarball], [data-release-module]').count(), 0);
      for (const [manager, prefix] of [['npm', 'npm install'], ['pnpm', 'pnpm add'], ['yarn', 'yarn add'], ['bun', 'bun add']]) {
        await page.locator(`[data-package-manager="${manager}"]`).click();
        const expectedCommand = await page.evaluate(prefix => window.__home.state.release.installCommand.replace(/^npm install/, prefix), prefix);
        assert.equal(await page.locator('[data-install-command]').textContent(), expectedCommand);
        assert.equal(await page.locator(`[data-package-manager="${manager}"]`).getAttribute('aria-pressed'), 'true');
        await page.locator('[data-copy-install]').click();
        assert.equal(await page.evaluate(() => window.__copiedText), expectedCommand);
      }
      report.interactions.push('Separate Downloads page with four branded package managers and command copying');
    }
    if (route === '/getting-started.html') {
      assert.match(page.url(), /\/docs(?:\.html)?#install$/);
    }
    if (route === '/docs.html') {
      assert.ok(await page.locator('#doc-toc a[href^="#"]').count() >= 15);
      assert.equal(await page.locator('#doc-article section:visible').count(), 1);
      await page.locator('#doc-search').fill('memory');
      assert.ok(await page.locator('#doc-toc a:visible').count() > 0);
      await page.locator('#doc-toc a[href="#performance-and-memory"]').click();
      assert.match(await page.locator('#doc-article').textContent(), /Performance and memory/);
      await page.locator('#doc-search').fill('no-such-topic-1234');
      assert.equal(await page.locator('#doc-toc a:visible').count(), 0);
      assert.match(await page.locator('#doc-results').textContent(), /No .*match/i);
      await page.locator('#doc-search').fill('');
      await page.locator('#doc-toc a[href="#models-and-ai-agents"]').click();
      assert.match(page.url(),/models-and-ai-agents/);
      await page.locator('#doc-toc a[href="#getting-started"]').click();
      assert.equal(await page.locator('#getting-started ol li').count(), 3);
      const headerBounds = await page.locator('.navigation').boundingBox();
      const copyBounds = await page.locator('#copy-doc-page').boundingBox();
      assert.ok(copyBounds.y >= headerBounds.y + headerBounds.height, 'Sticky header covers Copy page');
      assert.ok(await page.locator('.hljs-keyword').count() > 0);
      assert.ok(await page.locator('.code-block').count() >= 2);
      assert.equal(await page.locator('#copy-doc-page').count(), 1);
      await page.locator('#copy-doc-page').click();
      assert.match(await page.evaluate(() => window.__copiedText), /^## Getting started/);
      assert.ok(!(await page.evaluate(() => window.__copiedText)).includes('## Parts and geometry'));
      const firstCode = page.locator('.code-block').first();
      await firstCode.locator('.copy-code').click();
      assert.equal(await page.evaluate(() => window.__copiedText), await firstCode.locator('code').textContent());
      report.interactions.push('Grouped docs, selected articles, search, deep links and labeled syntax highlighting');
    }
    if (route === '/object.html') {
      await page.locator('[data-view="face"]').click();
      assert.equal(await page.evaluate(() => window.__studio.state.targetHeight),2.55);
      await page.locator('#look').selectOption('warm');
      await page.locator('[data-view="machine"]').click();
      assert.equal(await page.evaluate(() => window.__studio.state.assembly),0.65);
      const download = page.waitForEvent('download');
      await page.locator('#save-model').click();
      assert.equal((await download).suggestedFilename(),'67js-wall-e.png');
      await page.locator('#assembly-tour').click();
      assert.equal(await page.evaluate(() => window.__studio.state.touring),false);
      const graphics = await page.evaluate(() => window.__studio.renderer.context.getError());
      assert.equal(graphics,0);
      report.interactions.push('Object viewpoints, lighting, PNG and reduced-motion assembly toggle');
    }
    if (route === '/motion.html') {
      await page.locator('#motion-look').selectOption('neutral');
      await page.locator('#motion-aspect').selectOption('portrait');
      await page.evaluate(() => window.__scene.renderAt(3));
      const download = page.waitForEvent('download');
      await page.locator('#motion-save').click();
      assert.equal((await download).suggestedFilename(),'67js-clockwork.png');
      assert.equal(await page.evaluate(() => window.__scene.renderer.context.getError()),0);
      report.interactions.push('Motion looks, portrait framing, deterministic seek and PNG');
    }
    if (route === '/nature.html') {
      await page.locator('[data-daylight="0.5"]').click();
      assert.equal(await page.evaluate(() => window.__nature.state.daylight),0.5);
      assert.equal(await page.evaluate(() => window.__nature.renderer.context.getError()),0);
      report.interactions.push('Nature golden-hour preset');
    }
  }
  await page.emulateMedia({colorScheme:'light'});
  await page.goto(origin);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--window').trim()),'#fff');
  await page.screenshot({path:'artifacts/site-home-light.png',fullPage:true});
  await page.goto(`${origin}/object.html`);
  await page.waitForFunction(() => window.__studio?.renderer);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('#assembly-tour').click();
  await page.waitForFunction(() => window.__studio.state.assembly > 0.01);
  await page.locator('#assembly-tour').click();
  assert.equal(await page.evaluate(() => window.__studio.state.touring),false);
  report.interactions.push('Assembly playback and pause');
  for (const resource of ['/guide.md','/llms.txt','/gltf.md','/favicon.svg','/logo.svg']) {
    const response = await page.request.get(origin + resource);
    assert.equal(response.status(),200,resource);
  }
  assert.deepEqual(errors,[]);
  await writeFile('artifacts/site-checks.json',JSON.stringify(report,null,2));
  console.log(`Site passed: ${report.layouts.length} layouts, ${report.interactions.length} interaction groups, light/dark theme and agent resources.`);
} finally { await browser.close(); }
