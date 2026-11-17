# Privacy Policy

Audio Normalizer processes audio locally in the browser.

## Data Collection

- No audio is uploaded or transmitted.
- No browsing history is collected.
- No personal data is sold or shared.

## Permissions

- `storage` is used to save per-site enable/disable state and gain locally.
- `scripting` registers the extension's own content script for the hosts you switch on, and injects the extension's own page hook into those pages so their audio can be routed through the normalizer. A host you have not switched on has no script registered at all, an excluded host has none either, and nothing is injected into browser, extension or web store pages.
- `host_permissions` are used so the extension can normalize audio on sites the user enables.

## Local per-site preferences

- One record per site key is kept in `chrome.storage.local`: whether the site is active, its gain, and whether it is excluded.
- That record stays on this device. It is never sent to a server, never synced to an account, and no analytics or telemetry reads it.
- Clearing the extension's data or uninstalling the extension removes it.

## Contact

If this policy needs a support contact or website URL, add it before Chrome Web Store submission.
