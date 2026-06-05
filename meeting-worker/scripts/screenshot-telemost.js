// Opens a Telemost meeting URL, waits, takes screenshots at key moments.
// Usage: node scripts/screenshot-telemost.js <joinUrl>
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const joinUrl = process.argv[2] || "https://telemost.yandex.ru/j/00841232733983";
const outDir = path.join(__dirname, "../screenshots");
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  console.log("Launching Chromium...");
  const browser = await chromium.launch({
    headless: true, // headless = no OS protocol-handler dialog for telemost://
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  const context = await browser.newContext({
    permissions: ["microphone", "camera"],
    locale: "ru-RU",
  });

  const page = await context.newPage();

  console.log(`Navigating to ${joinUrl}...`);
  await page.goto(joinUrl, { waitUntil: "networkidle", timeout: 30000 });

  // Screenshot 1: after networkidle (React app rendered)
  await page.screenshot({ path: path.join(outDir, "01_lobby.png"), fullPage: true });
  console.log("Screenshot 01_lobby.png saved");

  // Print all visible text
  const text = await page.evaluate("document.body.innerText");
  console.log("\n--- Page text ---\n", text.slice(0, 1000));

  // Print all inputs and buttons
  const interactive = await page.evaluate(() => {
    const els = [...document.querySelectorAll("input, button, [role=button]")];
    return els.map(el => ({
      tag: el.tagName,
      type: el.getAttribute("type"),
      placeholder: el.getAttribute("placeholder"),
      ariaLabel: el.getAttribute("aria-label"),
      text: el.textContent?.trim().slice(0, 80),
      dataTestId: el.getAttribute("data-testid"),
      className: el.className?.toString().slice(0, 80),
    }));
  });
  console.log("\n--- Interactive elements ---");
  console.log(JSON.stringify(interactive, null, 2));

  // Click "Продолжить в браузере" to skip the app-selector interstitial.
  console.log("\nClicking 'Продолжить в браузере'...");
  await page.click('button:has-text("Продолжить в браузере")', { timeout: 10000 });

  // Wait for the lobby join button to appear (SPA transition).
  await page.waitForSelector('[data-testid="enter-conference-button"]', { timeout: 20000 });

  // Screenshot 2: real lobby
  await page.screenshot({ path: path.join(outDir, "02_real_lobby.png"), fullPage: true });
  console.log("Screenshot 02_real_lobby.png saved");

  // Fill bot name
  const nameInput = await page.$('[data-testid="orb-textinput-input"]');
  if (nameInput) {
    await nameInput.fill("Meeting Bot");
    console.log("Name filled");
  }

  // Click "Подключиться"
  console.log("\nClicking 'Подключиться'...");
  await page.click('[data-testid="enter-conference-button"]', { timeout: 10000 });

  // Wait for in-call UI — lobby disappears and call controls appear.
  // The join button is gone once we're inside the room.
  console.log("Waiting for in-call UI (lobby to disappear)...");
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="enter-conference-button"]'),
    { timeout: 30000, polling: 500 }
  );
  await page.waitForTimeout(2000);

  // Screenshot 3: inside the call
  await page.screenshot({ path: path.join(outDir, "03_in_call.png"), fullPage: true });
  console.log("Screenshot 03_in_call.png saved");

  const text3 = await page.evaluate("document.body.innerText");
  console.log("\n--- In-call page text ---\n", text3.slice(0, 1000));

  const interactive3 = await page.evaluate(() => {
    const els = [...document.querySelectorAll("input, button, [role=button]")];
    return els.map(el => ({
      tag: el.tagName,
      ariaLabel: el.getAttribute("aria-label"),
      text: el.textContent?.trim().slice(0, 60),
      dataTestId: el.getAttribute("data-testid"),
    })).filter(el => el.dataTestId || el.ariaLabel || el.text);
  });
  console.log("\n--- In-call interactive elements ---");
  console.log(JSON.stringify(interactive3, null, 2));

  await page.waitForTimeout(3000);
  await browser.close();
  console.log("\nDone. Check meeting-worker/screenshots/");
})().catch(e => { console.error(e); process.exit(1); });
