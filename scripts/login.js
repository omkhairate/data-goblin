import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const profileDir = process.env.WINSIM_PROFILE_DIR || path.join(rootDir, '.winsim-profile');
const targetUrl =
  process.env.WINSIM_TARGET_URL ||
  'https://service.winsim.de/mytariff/invoice/showServicesAndOptions';

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1440, height: 950 }
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

console.log('\nA browser window is open.');
console.log('Log in to winSIM manually and navigate to the tariff/data options page if needed.');
console.log('When the page is loaded, come back here and press Enter to save the session.\n');

const rl = readline.createInterface({ input, output });
await rl.question('Press Enter after login is complete...');
rl.close();

await context.storageState({ path: path.join(rootDir, 'storage-state.json') });
await context.close();

console.log(`\nSaved browser profile at: ${profileDir}`);
console.log('You can now run: npm run monitor');
