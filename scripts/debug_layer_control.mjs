import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const adminPass = fs.readFileSync('secrets/kmc_master_admin_password.txt', 'utf8').trim();

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

  // Expand Vector Layers accordion
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('#layer-control-panel button'));
    const vecBtn = btns.find((b) => b.textContent.includes('भेक्टर तहहरू'));
    if (vecBtn) vecBtn.click();
  });
  await new Promise((r) => setTimeout(r, 600));

  const badges = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('span')).filter((s) => s.textContent.includes('घर नम्बर तह'));
    return b.map((x) => x.textContent.trim());
  });
  console.log('BADGES FOUND:', badges);

  await browser.close();
}

main().catch(console.error);
