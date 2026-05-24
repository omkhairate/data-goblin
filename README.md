# data-goblin

Small Playwright automation for the winSIM tariff/options page. It reuses a local browser profile and can restore expired sessions with credentials stored in macOS Keychain.

## Setup

```sh
cd /Users/apollo/Downloads/data-goblin
npm install
npx playwright install chromium
```

## Store credentials

```sh
npm run credentials
```

Enter the same login/customer number/phone/email and password you use on winSIM. The password is stored in macOS Keychain under the service name `winsim-auto-booker`, not in this project folder.

## Prime the browser profile once

```sh
npm run login
```

A browser opens. Log in to winSIM manually once, make sure the tariff/data options page loads, then return to the terminal and press Enter. After that, the monitor can automatically re-login when the saved web session expires.

## Run one check

```sh
WINSIM_USERNAME="your-login" AUTO_BOOK_1GB=true npm run monitor:once
```

## Keep monitoring

```sh
WINSIM_USERNAME="your-login" AUTO_BOOK_1GB=true npm run monitor
```

If your winSIM session expires, the script fills the login form from Keychain and resumes monitoring automatically. It retries from a fresh login page, classifies common failure states, and saves diagnostics in `diagnostics/` if it cannot recover. If winSIM requires CAPTCHA or another human check, the script sends a macOS notification, plays a sound, opens a one-time popup, repeats reminders while waiting, then resumes after you solve it and press Enter in the terminal.

By default it checks every 5 seconds and clicks whenever the 1 GB `Buchen` button is available. Change polling and login retry behavior with environment variables:

```sh
WINSIM_USERNAME="your-login" AUTO_BOOK_1GB=true CHECK_INTERVAL_MS=30000 LOGIN_MAX_ATTEMPTS=6 MANUAL_ATTENTION_REMINDER_MS=120000 MANUAL_ATTENTION_POPUP=true npm run monitor
```

If winSIM shows a second confirmation step after pressing `Buchen`, first run the script visibly and verify the wording. Then enable:

```sh
WINSIM_USERNAME="your-login" AUTO_BOOK_1GB=true CONFIRM_BOOKING=true npm run monitor
```

## Notes

- The script watches for the `1 GB-Highspeed-Datenpaket` row and clicks its `Buchen` button only when it is visible and not disabled.
- If your login expires, the monitor tries to log back in automatically with the Keychain password.
- CAPTCHA cannot be bypassed by the script; it is detected as a human handoff and then the automation continues.
- If macOS Focus mode hides notifications, allow notifications from Terminal/Script Editor for that Focus, or keep `MANUAL_ATTENTION_POPUP=true` so a popup appears too.
- Login failures save a screenshot and page text under `diagnostics/` so you can see why recovery stopped.
- You can also pass `WINSIM_PASSWORD` directly as an environment variable, but Keychain is safer.
- The files `.winsim-profile/`, `.booking-state.json`, and `storage-state.json` are local runtime state and should stay private.
