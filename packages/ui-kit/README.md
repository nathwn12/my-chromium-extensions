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
  <link rel="stylesheet" href="ui-kit/tokens.css">
  <link rel="stylesheet" href="ui-kit/components.css">
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
  <script type="module" src="ui-kit/switch.js"></script>
  ```

  It contains exactly:

  ```js
  if (!('switch' in HTMLInputElement.prototype)) import('input-switch-polyfill');
  ```

  The polyfill is intentionally **not bundled** here: the dynamic import stays in the shipped file, so the consuming extension must install/serve `input-switch-polyfill` itself. On browsers with native switch support, nothing is fetched. When the import cannot resolve, the loader swallows it and the switch stays a plain checkbox.

## Palette (nathwn12)

One palette for every extension page. Values are light-dark() pairs. Extension icons carry their own vivid artwork set on a dark tile.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| --bg | #f4f3ef | #16171b | page |
| --card | #ffffff | #23252b | cards |
| --line | #ddd8d0 | #33363d | borders |
| --ink | #1b1c1f | #ededed | text |
| --muted | #6b6f76 | #9aa0a8 | secondary text |
| --accent | #b5652e | #c97a3a | primary (burnt orange) |
| --accent-2 | #8e2f3c | #a8434f | secondary (muted crimson) |
| --neutral | #8a8f96 | #6b6f76 | neutral marks |
| --ok | #4f7f4f | #6fa36f | success |
| --warn | #8a6a1f | #c9a24a | warning |
| --bad | #8e3b3b | #b25454 | error |
