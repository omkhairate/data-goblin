import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const profileDir = process.env.WINSIM_PROFILE_DIR || path.join(rootDir, '.winsim-profile');
const statePath = path.join(rootDir, '.booking-state.json');
const diagnosticsDir = path.join(rootDir, 'diagnostics');

const targetUrl =
  process.env.WINSIM_TARGET_URL ||
  'https://service.winsim.de/mytariff/invoice/showServicesAndOptions';
const autoBook = process.env.AUTO_BOOK_1GB === 'true';
const confirmBooking = process.env.CONFIRM_BOOKING === 'true';
const headless = process.env.HEADLESS === 'true';
const once = process.argv.includes('--once');
const checkIntervalMs = Number(process.env.CHECK_INTERVAL_MS || 5_000);
const loginMaxAttempts = Number(process.env.LOGIN_MAX_ATTEMPTS || 4);
const manualAttentionReminderMs = Number(process.env.MANUAL_ATTENTION_REMINDER_MS || 120_000);
const manualAttentionPopup = process.env.MANUAL_ATTENTION_POPUP !== 'false';
const keychainService = process.env.WINSIM_KEYCHAIN_SERVICE || 'winsim-auto-booker';
const execFileAsync = promisify(execFile);

if (!autoBook) {
  throw new Error('Refusing to book until AUTO_BOOK_1GB=true is set in your environment.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readState() {
  try {
    return JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch {
    return { dateKey: todayKey(), bookingsToday: 0, lastBookedAt: null };
  }
}

async function writeState(state) {
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ || 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function resetDailyCounterIfNeeded(state) {
  const dateKey = todayKey();
  if (state.dateKey !== dateKey) {
    return { ...state, dateKey, bookingsToday: 0 };
  }
  return state;
}

async function isProbablyLoggedOut(page) {
  const passwordField = page.locator('input[type="password"]').first();
  if (await passwordField.isVisible().catch(() => false)) return true;
  return /login|anmelden/i.test(page.url());
}

async function isTargetPage(page) {
  if (page.url().includes('/mytariff/invoice/showServicesAndOptions')) return true;
  return page.locator('text=/Tarif- und Datenoptionen/i').first().isVisible().catch(() => false);
}

async function hasHumanChallenge(page) {
  const challenge = page.locator(
    [
      'iframe[src*="captcha" i]',
      'iframe[src*="recaptcha" i]',
      'iframe[src*="hcaptcha" i]',
      'iframe[src*="turnstile" i]',
      '[class*="captcha" i]',
      '[id*="captcha" i]',
      '[class*="recaptcha" i]',
      '[id*="recaptcha" i]',
      '[class*="hcaptcha" i]',
      '[id*="hcaptcha" i]',
      '[class*="turnstile" i]',
      '[id*="turnstile" i]',
      'text=/captcha|sicherheitsabfrage|ich bin kein roboter|robot|zeichen|sicherheitscode|prüfcode|pruefcode|code eingeben/i'
    ].join(', ')
  );

  return (await challenge.count().catch(() => 0)) > 0;
}

async function hasManualActionPrompt(page) {
  if (await hasHumanChallenge(page)) return true;

  const bodyText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  if (
    /captcha|sicherheitsabfrage|ich bin kein roboter|robot|zeichen|sicherheitscode|prüfcode|pruefcode|code eingeben|eingeben.*code|angezeigten/i.test(
      bodyText
    )
  ) {
    return true;
  }

  const visibleTextInputs = await page
    .locator(
      [
        'input[type="text"]:visible',
        'input:not([type]):visible',
        'input[inputmode]:visible',
        'textarea:visible'
      ].join(', ')
    )
    .count()
    .catch(() => 0);

  const onLoginPage = await isProbablyLoggedOut(page).catch(() => false);
  return visibleTextInputs > 0 && !onLoginPage;
}

async function launchBrowser({ forceVisible = false } = {}) {
  try {
    return await chromium.launchPersistentContext(profileDir, {
      headless: forceVisible ? false : headless,
      viewport: { width: 1440, height: 950 }
    });
  } catch (error) {
    if (/existing browser session|profile is already in use/i.test(error.message)) {
      throw new Error(
        'The winSIM browser profile is already in use. Keep the existing monitor running, or stop it with Ctrl+C before starting another one.'
      );
    }
    throw error;
  }
}

function appleScriptString(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function notifyHumanChallenge(repeated = false) {
  const message = `${repeated ? 'Still waiting: c' : 'C'}heck the winSIM CAPTCHA/login page, then return to Terminal and press Enter.`;
  console.log(`winSIM requires manual login attention. ${message}`);

  output.write('\u0007');
  execFile('afplay', ['/System/Library/Sounds/Ping.aiff'], () => {});

  await execFileAsync('osascript', [
    '-e',
    `display notification ${appleScriptString(message)} with title "data-goblin" sound name "Ping"`
  ]).catch(() => {});

  if (manualAttentionPopup && !repeated) {
    execFile(
      'osascript',
      [
        '-e',
        `display dialog ${appleScriptString(message)} with title "data-goblin needs you" buttons {"OK"} default button "OK" giving up after 30`
      ],
      () => {}
    );
  }
}

async function saveDiagnostics(page, reason) {
  await fs.mkdir(diagnosticsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(diagnosticsDir, `login-${stamp}`);
  const screenshotPath = `${base}.png`;
  const textPath = `${base}.txt`;

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  await fs
    .writeFile(
      textPath,
      [
        `time: ${new Date().toISOString()}`,
        `url: ${page.url()}`,
        `reason: ${reason}`,
        '',
        bodyText
      ].join('\n')
    )
    .catch(() => {});

  console.warn(`[${new Date().toISOString()}] Saved login diagnostics: ${screenshotPath}`);
  return { screenshotPath, textPath };
}

async function getVisibleLoginMessages(page) {
  return page
    .locator('body')
    .evaluate((body) =>
      body.innerText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) =>
          /nicht korrekt|fehler|gesperrt|captcha|zeichen|sicherheits|passwort|benutzer|login|anmelden/i.test(
            line
          )
        )
        .slice(0, 12)
    )
    .catch(() => []);
}

async function inspectLoginState(page) {
  if (await isTargetPage(page)) {
    return { status: 'LOGGED_IN', reason: 'target page visible' };
  }

  if (await hasHumanChallenge(page)) {
    return { status: 'MANUAL_ATTENTION', reason: 'human challenge detected' };
  }

  const messages = await getVisibleLoginMessages(page);
  const messageText = messages.join(' | ');

  if (/nicht korrekt|falsch|ungültig|ungueltig|incorrect/i.test(messageText)) {
    return {
      status: 'BAD_CREDENTIALS',
      reason: messageText || 'login rejected credentials'
    };
  }

  if (/gesperrt|locked|temporär|temporar|zu viele/i.test(messageText)) {
    return {
      status: 'MANUAL_ATTENTION',
      reason: messageText || 'account appears locked or throttled'
    };
  }

  if (await isProbablyLoggedOut(page)) {
    return {
      status: 'LOGGED_OUT',
      reason: messageText || `login form visible at ${page.url()}`
    };
  }

  return {
    status: 'UNKNOWN',
    reason: messageText || `unknown state at ${page.url()}`
  };
}

async function getKeychainCredentials() {
  if (process.env.WINSIM_USERNAME && process.env.WINSIM_PASSWORD) {
    return {
      username: process.env.WINSIM_USERNAME,
      password: process.env.WINSIM_PASSWORD
    };
  }

  if (process.env.WINSIM_USERNAME && !process.env.WINSIM_PASSWORD) {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      keychainService,
      '-a',
      process.env.WINSIM_USERNAME,
      '-w'
    ]);
    return { username: process.env.WINSIM_USERNAME, password: stdout.trimEnd() };
  }

  throw new Error(
    'Automatic login needs credentials. Run `npm run credentials`, then start with `WINSIM_USERNAME=your-login AUTO_BOOK_1GB=true npm run monitor`.'
  );
}

async function firstVisible(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const field = await firstVisible(page.locator(selector));
    if (field) {
      await field.fill(value);
      return true;
    }
  }
  return false;
}

async function dismissBlockingOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {});

  const closeButton = page
    .locator(
      [
        'dialog[open] button[aria-label*="close" i]',
        'dialog[open] button[aria-label*="schließen" i]',
        'dialog[open] button[title*="close" i]',
        'dialog[open] button[title*="schließen" i]',
        'dialog[open] .close',
        'dialog[open] .c-overlay-close',
        'dialog[open] [data-dismiss]',
        'dialog[open] [data-close]'
      ].join(', ')
    )
    .first();

  if (await closeButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await closeButton.click({ timeout: 3000 }).catch(() => {});
  }

  await page
    .locator('dialog[open], #c-overlay')
    .evaluateAll((dialogs) => {
      for (const dialog of dialogs) {
        if (typeof dialog.close === 'function') dialog.close();
        dialog.removeAttribute('open');
        dialog.style.display = 'none';
      }
    })
    .catch(() => {});
}

async function clickLoginSubmit(page) {
  await dismissBlockingOverlays(page);

  const loginForm = page.locator('form#loginAction, form').filter({
    has: page.locator('input[type="password"]')
  });
  const form = await firstVisible(loginForm);

  if (form) {
    const formSubmit = await firstVisible(
      form.locator(
        [
          'a[onclick*="submitForm"][onclick*="loginAction"]',
          'a.submitOnEnter[title="Login"]',
          '.p-site-login-button-bar a.c-button',
          'button[type="submit"]',
          'input[type="submit"]'
        ].join(', ')
      )
    );
    if (formSubmit) {
      await dismissBlockingOverlays(page);
      await formSubmit.click({ timeout: 10_000 });
      return;
    }
  }

  const button = page
    .getByRole('button', { name: /einloggen|login|anmelden|weiter/i })
    .or(page.getByRole('link', { name: /einloggen|login|anmelden|weiter/i }))
    .first();

  if (await button.isVisible({ timeout: 5000 }).catch(() => false)) {
    await button.click();
    return;
  }

  const submit = await firstVisible(page.locator('button[type="submit"], input[type="submit"]'));
  if (submit) {
    await submit.click();
    return;
  }

  await page.keyboard.press('Enter');
}

async function attemptAutoLogin(page, credentials, attempt) {
  if (attempt > 1 || !(await isProbablyLoggedOut(page))) {
    await page.goto('https://service.winsim.de/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  }

  await dismissBlockingOverlays(page);

  const usernameFilled = await fillFirstVisible(
    page,
    [
      'input[type="email"]',
      'input[type="tel"]',
      'input[name*="user" i]',
      'input[id*="user" i]',
      'input[name*="login" i]',
      'input[id*="login" i]',
      'input[name*="kund" i]',
      'input[id*="kund" i]',
      'input[name*="ruf" i]',
      'input[id*="ruf" i]',
      'input[name*="phone" i]',
      'input[id*="phone" i]',
      'input[name*="mail" i]',
      'input[id*="mail" i]',
      'input:not([type]), input[type="text"]'
    ],
    credentials.username
  );

  const passwordFilled = await fillFirstVisible(page, ['input[type="password"]'], credentials.password);

  if (!usernameFilled || !passwordFilled) {
    throw new Error('Could not find the winSIM login fields. The login page markup may have changed.');
  }

  await clickLoginSubmit(page);
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page
    .waitForURL((url) => !/\/$|login|login_check|anmelden/i.test(url.pathname), { timeout: 15_000 })
    .catch(() => {});

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  return inspectLoginState(page);
}

async function autoLogin(page) {
  console.log(`[${new Date().toISOString()}] Session expired. Trying automatic login...`);
  const credentials = await getKeychainCredentials();

  for (let attempt = 1; attempt <= loginMaxAttempts; attempt += 1) {
    const result = await attemptAutoLogin(page, credentials, attempt);
    if (result.status === 'LOGGED_IN') {
      console.log(`[${new Date().toISOString()}] Automatic login restored. Resuming monitoring.`);
      return 'OK';
    }

    console.warn(
      `[${new Date().toISOString()}] Automatic login attempt ${attempt} did not finish: ${result.reason}`
    );

    if (result.status === 'BAD_CREDENTIALS') {
      await saveDiagnostics(page, result.reason);
      throw new Error(`winSIM rejected the stored credentials: ${result.reason}`);
    }

    if (result.status === 'MANUAL_ATTENTION') {
      await saveDiagnostics(page, result.reason);
      return 'MANUAL_ATTENTION';
    }

    await sleep(Math.min(10_000, attempt * 2_000));
  }

  await saveDiagnostics(page, `automatic login still failed after ${loginMaxAttempts} attempts`);
  return 'MANUAL_ATTENTION';
}

async function waitForHumanChallenge(context) {
  let nextContext = context;

  if (headless) {
    await context.close();
    nextContext = await launchBrowser({ forceVisible: true });
  }

  const nextPage = nextContext.pages()[0] || (await nextContext.newPage());
  await notifyHumanChallenge();

  const reminder =
    manualAttentionReminderMs > 0
      ? setInterval(() => {
          notifyHumanChallenge(true).catch(() => {});
        }, manualAttentionReminderMs)
      : null;

  const rl = readline.createInterface({ input, output });
  try {
    await rl.question('Handle the winSIM CAPTCHA/login/booking check in the browser, then press Enter here...');
  } finally {
    if (reminder) clearInterval(reminder);
    rl.close();
  }

  await nextPage.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await nextPage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  if (await hasHumanChallenge(nextPage) || (await isProbablyLoggedOut(nextPage))) {
    throw new Error('winSIM still appears to require a human challenge or login.');
  }

  console.log(`[${new Date().toISOString()}] Manual login cleared. Resuming monitoring.`);
  return { context: nextContext, page: nextPage };
}

async function restoreLogin(context, page) {
  let result;
  try {
    result = await autoLogin(page);
  } catch (error) {
    console.warn(`[${new Date().toISOString()}] Automatic login needs attention: ${error.message}`);
    result = 'MANUAL_ATTENTION';
  }

  if (result !== 'MANUAL_ATTENTION') {
    return { context, page };
  }

  return waitForHumanChallenge(context);
}

async function findBookButton(page) {
  const row = page
    .locator('tr, li, div, section')
    .filter({ hasText: /1\s*GB[-\s]*Highspeed[-\s]*Datenpaket/i })
    .first();

  const inRowButton = row
    .locator('button, a, [role="button"], input[type="button"], input[type="submit"]')
    .filter({ hasText: /^Buchen$/i })
    .first();

  if (await inRowButton.count()) return inRowButton;

  return page
    .getByRole('button', { name: /^Buchen$/i })
    .or(page.getByRole('link', { name: /^Buchen$/i }))
    .first();
}

async function isUnavailable(button) {
  const disabled = await button.isDisabled().catch(() => false);
  if (disabled) return true;

  const disabledAttr = await button.getAttribute('disabled').catch(() => null);
  if (disabledAttr !== null) return true;

  const ariaDisabled = await button.getAttribute('aria-disabled').catch(() => null);
  if (ariaDisabled === 'true') return true;

  const classes = await button.getAttribute('class').catch(() => '');
  if (/\bdisabled\b|inactive|deaktiviert/i.test(classes || '')) return true;

  const styleState = await button
    .evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        pointerEvents: style.pointerEvents,
        opacity: Number(style.opacity)
      };
    })
    .catch(() => null);
  if (styleState?.pointerEvents === 'none' || styleState?.opacity < 0.5) return true;

  return false;
}

async function clickOptionalConfirmation(page) {
  const confirmation = page
    .getByRole('button', {
      name: /kostenpflichtig|zahlungspflichtig|bestätigen|buchen|ja/i
    })
    .first();

  if (await confirmation.isVisible({ timeout: 5000 }).catch(() => false)) {
    await confirmation.click();
    return true;
  }

  return false;
}

async function checkAndMaybeBook(page) {
  if (await hasManualActionPrompt(page)) {
    console.log(`[${new Date().toISOString()}] Manual challenge is already open; pausing without refresh.`);
    return 'MANUAL_ATTENTION';
  }

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('load', { timeout: 3_000 }).catch(() => {});

  if (await hasManualActionPrompt(page)) {
    return 'MANUAL_ATTENTION';
  }

  if (await isProbablyLoggedOut(page)) {
    return 'LOGIN_REQUIRED';
  }

  const bookButton = await findBookButton(page);
  if (!(await bookButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
    console.log(`[${new Date().toISOString()}] No visible 1 GB "Buchen" button found.`);
    return;
  }

  if (await isUnavailable(bookButton)) {
    console.log(`[${new Date().toISOString()}] "Buchen" is visible but not available yet.`);
    return;
  }

  console.log(`[${new Date().toISOString()}] Booking button is available. Clicking...`);
  try {
    await bookButton.click({ timeout: 3_000 });
  } catch (error) {
    if (await isUnavailable(bookButton)) {
      console.log(`[${new Date().toISOString()}] "Buchen" became unavailable before click completed.`);
      return;
    }

    console.warn(`[${new Date().toISOString()}] Could not click "Buchen": ${error.message}`);
    return;
  }

  await page.waitForLoadState('load', { timeout: 3_000 }).catch(() => {});
  await page.waitForTimeout(750);

  if (await hasManualActionPrompt(page)) {
    console.log(`[${new Date().toISOString()}] winSIM showed a CAPTCHA/manual check after booking click.`);
    return 'MANUAL_ATTENTION';
  }

  if (confirmBooking) {
    const confirmed = await clickOptionalConfirmation(page);
    console.log(confirmed ? 'Clicked confirmation button.' : 'No confirmation button appeared.');

    await page.waitForLoadState('load', { timeout: 3_000 }).catch(() => {});
    if (await hasManualActionPrompt(page)) {
      console.log(`[${new Date().toISOString()}] winSIM showed a CAPTCHA/manual check after confirmation.`);
      return 'MANUAL_ATTENTION';
    }
  }

  const state = resetDailyCounterIfNeeded(await readState());
  state.bookingsToday += 1;
  state.lastBookedAt = new Date().toISOString();
  await writeState(state);
  console.log(`[${new Date().toISOString()}] Booking attempt recorded.`);
  return 'OK';
}

let context = await launchBrowser();
let page = context.pages()[0] || (await context.newPage());

try {
  do {
    const result = await checkAndMaybeBook(page);
    if (result === 'LOGIN_REQUIRED') {
      const restored = await restoreLogin(context, page);
      context = restored.context;
      page = restored.page;
    }
    if (result === 'MANUAL_ATTENTION') {
      const restored = await waitForHumanChallenge(context);
      context = restored.context;
      page = restored.page;
    }
    if (!once) await sleep(checkIntervalMs);
  } while (!once);
} finally {
  await context.close();
}
