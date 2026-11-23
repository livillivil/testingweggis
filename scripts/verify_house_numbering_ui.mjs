import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import assert from 'assert';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE_URL = 'http://localhost';
const ARTIFACT_DIR = 'C:\\Users\\jksan\\.gemini\\antigravity\\brain\\dc9d26db-9032-4a8a-9e88-8626ade59a5e';

async function main() {
  console.log('================================================================');
  console.log('HOUSE NUMBERING SCOPING UI VERIFICATION');
  console.log('================================================================');

  const adminPass = fs.readFileSync('secrets/kmc_master_admin_password.txt', 'utf8').trim();

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
    defaultViewport: { width: 1920, height: 1080 },
  });

  try {
    const page = await browser.newPage();

    // 1. Login
    console.log('\n[1/4] Logging in as Master Admin...');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle2' });
    await page.type('input#username, input[name="username"]', 'KmcMasterAdmin2083');
    await page.type('input#password, input[name="password"]', adminPass);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2' }),
    ]);

    assert(page.url().includes('/dashboard'), 'Must be on /dashboard');
    await page.waitForFunction(() => typeof window.__kmcMap !== 'undefined', { timeout: 15000 });
    console.log('Dashboard loaded successfully.');

    // 2. Open Layer Control in Global View (No Project Selected)
    console.log('\n[2/4] Testing Global View (No Project Selected)...');
    const layerBtn = await page.waitForSelector('#layer-control-panel > button', { timeout: 5000 });
    await layerBtn.click();
    await new Promise((r) => setTimeout(r, 800));

    // Check if "घर नं" button exists in DOM
    const hnBtnGlobal = await page.$('button[title*="घर नम्बर लेबल"]');
    console.log(`Global View: House Number toggle button present: ${Boolean(hnBtnGlobal)}`);
    assert.strictEqual(Boolean(hnBtnGlobal), false, 'House number button MUST NOT exist when no project with house numbering is active');

    // Check if "घर नम्बर तह" badge exists in layer cards
    const hnBadgeGlobal = await page.evaluate(() => {
      const badges = Array.from(document.querySelectorAll('span')).filter(s => s.textContent.includes('घर नम्बर तह'));
      return badges.length;
    });
    console.log(`Global View: House Number layer badge count: ${hnBadgeGlobal}`);
    assert.strictEqual(hnBadgeGlobal, 0, 'No layer should display house numbering badge in global view');

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'step1_global_no_hn.png'), fullPage: false });
    console.log('Saved screenshot step1_global_no_hn.png');

    // 3. Switch to Project 1 (HN Disabled)
    console.log('\n[3/4] Testing Project 1 (HN Disabled)...');
    const projectSelector = await page.waitForSelector('#project-selector', { timeout: 5000 });
    await projectSelector.click();
    await new Promise((r) => setTimeout(r, 600));

    // Find option containing 'भौतिक पूर्वाधार'
    const p1Clicked = await page.evaluate(() => {
      const dropdown = document.querySelector('#project-dropdown');
      if (!dropdown) return false;
      const btns = Array.from(dropdown.querySelectorAll('button'));
      const target = btns.find(b => b.textContent.includes('भौतिक पूर्वाधार'));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    assert(p1Clicked, 'Failed to click Project 1 in dropdown');
    await new Promise((r) => setTimeout(r, 1200));

    // Ensure Layer Control is open
    const isLCOpen1 = await page.$('#layer-control-panel .shadow-2xl');
    if (!isLCOpen1) {
      const lBtn = await page.$('#layer-control-panel > button');
      if (lBtn) await lBtn.click();
      await new Promise((r) => setTimeout(r, 600));
    }

    const hnBtnProj1 = await page.$('button[title*="घर नम्बर लेबल"]');
    console.log(`Project 1 (HN Disabled): House Number toggle button present: ${Boolean(hnBtnProj1)}`);
    assert.strictEqual(Boolean(hnBtnProj1), false, 'House number button MUST NOT exist when project has house numbering disabled');

    const hnBadgeProj1 = await page.evaluate(() => {
      const badges = Array.from(document.querySelectorAll('span')).filter(s => s.textContent.includes('घर नम्बर तह'));
      return badges.length;
    });
    console.log(`Project 1 (HN Disabled): House Number layer badge count: ${hnBadgeProj1}`);
    assert.strictEqual(hnBadgeProj1, 0, 'No layer should display house numbering badge in project with HN disabled');

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'step2_project_hn_disabled.png'), fullPage: false });
    console.log('Saved screenshot step2_project_hn_disabled.png');

    // 4. Switch to Project 2 (HN Enabled)
    console.log('\n[4/4] Testing Project 2 (HN Enabled)...');
    await projectSelector.click();
    await new Promise((r) => setTimeout(r, 600));

    const p2Clicked = await page.evaluate(() => {
      const dropdown = document.querySelector('#project-dropdown');
      if (!dropdown) return false;
      const btns = Array.from(dropdown.querySelectorAll('button'));
      const target = btns.find(b => b.textContent.includes('वडा ४ घर नम्बरिङ'));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    assert(p2Clicked, 'Failed to click Project 2 in dropdown');
    await new Promise((r) => setTimeout(r, 1200));

    // Ensure Layer Control is open
    const isLCOpen2 = await page.$('#layer-control-panel .shadow-2xl');
    if (!isLCOpen2) {
      const lBtn = await page.$('#layer-control-panel > button');
      if (lBtn) await lBtn.click();
      await new Promise((r) => setTimeout(r, 600));
    }

    // Ensure Vector Layers section is expanded
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('#layer-control-panel button'));
      const vecBtn = btns.find((b) => b.textContent.includes('भेक्टर तहहरू'));
      const list = document.querySelector('#layer-control-panel .space-y-1\\.5');
      if (vecBtn && !list) vecBtn.click();
    });
    await new Promise((r) => setTimeout(r, 600));

    const hnBtnProj2 = await page.$('button[title*="घर नम्बर लेबल"]');
    console.log(`Project 2 (HN Enabled): House Number toggle button present: ${Boolean(hnBtnProj2)}`);
    assert(Boolean(hnBtnProj2), 'House number button MUST exist when project has house numbering enabled!');

    const hnBadgesProj2 = await page.evaluate(() => {
      const badges = Array.from(document.querySelectorAll('span')).filter(s => s.textContent.includes('घर नम्बर तह'));
      return badges.map(b => b.textContent.trim());
    });
    console.log(`Project 2 (HN Enabled): House Number layer badges found:`, hnBadgesProj2);
    assert(hnBadgesProj2.length > 0, 'Layers associated with house numbering must display the "घर नम्बर तह" badge!');

    // Click "घर नं" button to toggle house number labels on map
    await hnBtnProj2.click();
    console.log('Clicked "घर नं" button to toggle house numbering labels on map.');
    await new Promise((r) => setTimeout(r, 1000));

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'step3_project_hn_enabled.png'), fullPage: false });
    console.log('Saved screenshot step3_project_hn_enabled.png');

    console.log('\n================================================================');
    console.log('ALL HOUSE NUMBERING SCOPING UI TESTS PASSED SUCCESSFULLY!');
    console.log('================================================================');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('\nVerification failed:', err);
  process.exit(1);
});
