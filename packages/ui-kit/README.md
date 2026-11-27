# ui-kit

Shared styles for the extensions in `my-chromium-extensions`. Files only: no build step, no runtime styling JS, and no changes to any existing extension or manifest.

## Files

| File | Purpose |
| --- | --- |
| `tokens.css` | `:root` design tokens using `light-dark()`. Load first. |
| `components.css` | Popup/options primitives built from the tokens. Load second. |
| `switch.js` | Conditional loader for `input-switch-polyfill`; not bundled. |

## Usage

Link both stylesheets in `popup.html` and `options.html`, before the extension's own stylesheet:

```html
<head>
  <meta name="color-scheme" content="light dark">
  <link rel="stylesheet" href="../ui-kit/tokens.css">
  <link rel="stylesheet" href="../ui-kit/components.css">
  <link rel="stylesheet" href="popup.css">
</head>
```

Add `<meta name="color-scheme" content="light dark">` to **both** `popup.html` and `options.html`. `light-dark()` picks its first value in light mode and its second in dark mode only when the document declares both schemes; without the meta tag the tokens resolve to their light values.

Set the accent per extension by overriding `--accent` on `:root` in a stylesheet loaded after `tokens.css`:

```css
:root { --accent: #f47521; }  /* crunchy-presence */
:root { --accent: #5865f2; }  /* youtube-music-presence */
```

The default is blue (`#3b82f6`) in both schemes. Any other token can be overridden the same way.

## Tokens

| Token | Light | Dark |
| --- | --- | --- |
| `--bg` | `#ffffff` | `#0d0f13` |
| `--card` | `#f1f5f9` | `#161a21` |
| `--line` | `#e2e8f0` | `#262c36` |
| `--ink` | `#0f172a` | `#e8ecf2` |
| `--muted` | `#64748b` | `#98a3b3` |
| `--accent` | `#3b82f6` | `#3b82f6` (override per extension) |
| `--ok` | `#15803d` | `#4ade80` |
| `--warn` | `#b45309` | `#fbbf24` |
| `--bad` | `#dc2626` | `#f87171` |

## Components

- `.popup` — 320px body width, 14px padding, 12px grid gap.
- `.pill` — `data-state` (`connected`, `connecting`, `idle`, `error`, `disconnected`, `off`) and `data-tone` (`connected`, `waiting`, `error`, `off`).
- `.card`, `.now`, `.detail`, `.buttons` (the latter is styled as a `<ul>`).
- `input[type="range"]` — `accent-color` plus the existing custom thumb.
- `input[type="checkbox"][switch]` — native switch, `accent-color`, 3px `:focus-visible` outline.
- `.toggle` — legacy custom switch wrapper, kept for compatibility.
- `footer a`, `footer button` — subtle links/buttons that highlight with `--accent`.
- `@media (prefers-reduced-motion: reduce)` removes switch transitions.

## Fallbacks

- **`accent-color` is progressive enhancement.** It is supported in current Chromium; the custom slider thumb and `.toggle` knob use `var(--accent)` directly, so color still works where `accent-color` is ignored. No polyfill for it.
- **Switch polyfill is conditional.** `input[type="checkbox"][switch]` is native in current Chrome. For older engines, load the loader as a module:

  ```html
  <script type="module" src="../ui-kit/switch.js"></script>
  ```

  It contains exactly:

  ```js
  if (!('switch' in HTMLInputElement.prototype)) import('input-switch-polyfill');
  ```

  The polyfill is intentionally **not bundled** here: the dynamic import stays in the shipped file, so the consuming extension must install/serve `input-switch-polyfill` itself. On browsers with native switch support, nothing is fetched.
