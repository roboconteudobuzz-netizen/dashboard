#!/usr/bin/env node
// Usage: node capture-post.js <postUrl> <notionPageId>
// Saves a PNG screenshot of the post cover to ./post-covers/<notionPageId>.png

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const [, , postUrl, notionPageId] = process.argv;

if (!postUrl || !notionPageId) {
  console.error('Usage: node capture-post.js <postUrl> <notionPageId>');
  process.exit(2);
}

const outDir = path.join(__dirname, 'post-covers');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${notionPageId}.png`);

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 2 });
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    // Try to locate the post media element; fall back to full page screenshot.
    const selector = 'article img, article video, main img';
    const el = await page.$(selector);
    if (el) {
      await el.screenshot({ path: outPath });
    } else {
      await page.screenshot({ path: outPath, fullPage: false });
    }

    console.log(JSON.stringify({ ok: true, path: outPath }));
    process.exit(0);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
