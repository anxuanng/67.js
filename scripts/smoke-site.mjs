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
  page.on('pageerror', error => errors.push(error.message));
  for (const route of ['/', '/docs.html', '/getting-started.html', '/object.html', '/motion.html', '/nature.html', '/assets.html', '/view2d.html', '/film.html']) {
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
    if (route === '/docs.html') {
      assert.ok(await page.locator('#doc-article section').count() >= 10);
      await page.locator('#doc-search').fill('memory');
      assert.ok(await page.locator('#doc-article section:visible').count() > 0);
      await page.locator('#doc-search').fill('no-such-topic-1234');
      await assert.equal(await page.locator('#doc-article section:visible').count(),0);
      assert.match(await page.locator('#doc-results').textContent(),/No matching/);
      await page.locator('#doc-search').fill('');
      await page.locator('#doc-toc a[href="#models-and-ai-agents"]').click();
      assert.match(page.url(),/models-and-ai-agents/);
      report.interactions.push('Docs search, empty state and topic links');
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
