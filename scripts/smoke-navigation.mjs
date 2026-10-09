import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.argv[2] ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
let checks = 0;

try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const route of ['/', '/downloads.html', '/docs.html', '/getting-started.html']) {
      await page.goto(origin + route);
      for (const width of [320, 390, 580, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        const linkPositions = await page.locator('.navigation nav a').evaluateAll(links => links.map(link => link.getBoundingClientRect().top));
        assert.ok(linkPositions.every(top => Math.abs(top - linkPositions[0]) < 1), 'Library navigation wraps to another row');
        const contrast = await page.locator(route === '/' ? '.navigation nav a:first-child' : '.navigation nav a[aria-current]').evaluate(link => {
          const channels = color => color.match(/[\d.]+/g).map(Number);
          const backgrounds = [];
          for (let element = link; element; element = element.parentElement) {
            backgrounds.unshift(channels(getComputedStyle(element).backgroundColor));
          }
          let background = [255, 255, 255];
          for (const layer of backgrounds) {
            const opacity = layer[3] ?? 1;
            background = background.map((channel, index) => layer[index] * opacity + channel * (1 - opacity));
          }
          const luminance = color => color.slice(0, 3).map(channel => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          }).reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
          const backgroundLight = luminance(background);
          const ratio = element => {
            const foregroundLight = luminance(channels(getComputedStyle(element).color));
            return (Math.max(foregroundLight, backgroundLight) + 0.05) / (Math.min(foregroundLight, backgroundLight) + 0.05);
          };
          const icon = link.querySelector('svg');
          return { text: ratio(link), icon: icon ? ratio(icon) : null };
        });
        assert.ok(contrast.text >= 4.5, `${route} ${colorScheme} ${width}: active text contrast ${contrast.text.toFixed(2)} < 4.5`);
        if (contrast.icon !== null) {
          assert.ok(contrast.icon >= 3, `${route} ${colorScheme} ${width}: active icon contrast < 3`);
        }
        checks += 1;
      }
    }
  }
  console.log(`Navigation contrast passed: ${checks} page/theme/viewport combinations.`);
} finally {
  await browser.close();
}
