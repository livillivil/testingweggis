import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const adminPass = fs.readFileSync('secrets/kmc_master_admin_password.txt', 'utf8').trim();
const ARTIFACT_DIR = 'C:\\Users\\jksan\\.gemini\\antigravity\\brain\\dc9d26db-9032-4a8a-9e88-8626ade59a5e';

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1920,1080'],
  });
  const page = await browser.newPage();
  await page.goto('http://localhost/login');
  await page.type('input#username, input[name="username"]', 'KmcMasterAdmin2083');
  await page.type('input#password, input[name="password"]', adminPass);
  await Promise.all([page.click('button[type="submit"]'), page.waitForNavigation()]);
  await page.waitForFunction(() => typeof window.__kmcMap !== 'undefined');

  // Select project 2
  await (await page.waitForSelector('#project-selector')).click();
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#project-dropdown button'));
    const t = btns.find((b) => b.textContent.includes('वडा ४ घर नम्बरिङ'));
    if (t) t.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  // Open layer control
  await (await page.waitForSelector('#layer-control-panel > button')).click();
  await new Promise((r) => setTimeout(r, 600));

  // Click the Eye icon on both vector layers to make them visible
  await page.evaluate(() => {
    // Find EyeOff icons or buttons inside layer cards
    const layerCards = Array.from(document.querySelectorAll('#layer-control-panel .rounded-md.border'));
    for (const card of layerCards) {
      const toggleBtn = card.querySelector('button');
      if (toggleBtn) {
        toggleBtn.click();
      }
    }
  });

  // Center map on Kathmandu center with zoom 16 to see the building footprints and roads
  await page.evaluate(async () => {
    const map = window.__kmcMap;
    if (map) {
      const view = map.getView();
      const lon = 85.312;
      const lat = 27.708;
      const x = (lon * 20037508.34) / 180;
      let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
      y = (y * 20037508.34) / 180;
      view.setCenter([x, y]);
      view.setZoom(16.5);
      map.renderSync();
    }
  });

  // Wait 3 seconds for vector features to stream in from PostGIS
  await new Promise((r) => setTimeout(r, 3500));

  const shotPath = path.join(ARTIFACT_DIR, 'dashboard_building_polygons_and_roads_visual.png');
  await page.screenshot({ path: shotPath, fullPage: false });
  console.log(`Saved screenshot: ${shotPath}`);

  await browser.close();
}

main().catch(console.error);
