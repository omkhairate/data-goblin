import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const execFileAsync = promisify(execFile);
const serviceName = process.env.WINSIM_KEYCHAIN_SERVICE || 'winsim-auto-booker';

function askHidden(question) {
  return new Promise((resolve) => {
    output.write(question);
    input.setRawMode?.(true);
    input.resume();

    let value = '';
    const onData = (buffer) => {
      const char = buffer.toString('utf8');

      if (char === '\u0003') {
        input.setRawMode?.(false);
        output.write('\n');
        process.exit(130);
      }

      if (char === '\r' || char === '\n') {
        input.off('data', onData);
        input.setRawMode?.(false);
        output.write('\n');
        resolve(value);
        return;
      }

      if (char === '\u007f') {
        value = value.slice(0, -1);
        return;
      }

      value += char;
    };

    input.on('data', onData);
  });
}

const rl = readline.createInterface({ input, output });
const username = (await rl.question('winSIM login/customer number/phone/email: ')).trim();
rl.close();

if (!username) {
  throw new Error('No username entered.');
}

const password = await askHidden('winSIM password: ');
if (!password) {
  throw new Error('No password entered.');
}

await execFileAsync('security', [
  'add-generic-password',
  '-U',
  '-s',
  serviceName,
  '-a',
  username,
  '-w',
  password
]);

console.log(`Stored winSIM credentials in macOS Keychain service "${serviceName}".`);
