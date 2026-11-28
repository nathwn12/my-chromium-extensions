# ui-kit

The single canonical design system for the extensions in `my-chromium-extensions`.
It is **files only**: two stylesheets, no build step, no runtime styling JS, no
package manifest changes. Every extension vendors byte-identical copies of
`tokens.css` and `components.css` into `packages/<name>/ui-kit/`; those copies
are committed static files, not generated output. `preview.html` is the eyeball
surface and never ships in an extension zip.

| File | Role |
| --- | --- |
| `tokens.css` | Palette, scales and product-identity tokens. Load first. |
| `components.css` | Popup/options primitives. Load second. |
| `preview.html` | Static all-components sheet at 320px and 560px, light and dark. Eyeball only. |
| `../scripts/ui-kit-sync.mjs` | Dev tool: copies the two CSS files byte-for-byte into every existing `ui-kit/` directory. |
| `../scripts/ui-kit-check.mjs` | Gate: hash drift, link order, token/class redefinition, leftover `switch.js`. |

### Removed

`switch.js` (the conditional `input-switch-polyfill` loader) is gone. The CSS
draws the switch itself with `appearance: none`, so the native-switch branch the
loader tested never rendered a polyfilled control; the dynamic package fetch was
dead weight inside an extension popup. There is exactly one switch implementation:
`.toggle input`.

## Palette

`light-dark()` values need `<meta name="color-scheme" content="light dark">`.
Contrast is WCAG relative luminance: light text tokens are measured on `--bg`
light `#f4f3ef` (except `--bad`, measured on `--card` light `#ffffff`); dark
text tokens are measured on `--card` dark `#23252b`.

| Token | Light | Dark | Contrast (light / dark) | Use |
| --- | --- | --- | --- | --- |
| `--bg` | `#f4f3ef` | `#16171b` | reference surface | page |
| `--card` | `#ffffff` | `#23252b` | reference surface | cards, inputs |
| `--line` | `#ddd8d0` | `#33363d` | 1.28 / 1.27 | quiet card edges only |
| `--line-strong` | `#8f8b84` | `#737a87` | 3.05 / 3.55 | control boundaries, slider tracks |
| `--ink` | `#1b1c1f` | `#ededed` | 15.35 / 13.08 | primary text |
| `--muted` | `#63676e` | `#9aa0a8` | 5.12 / 5.81 | secondary text |
| `--accent` | `#b5652e` | `#c97a3a` | 3.89 / 4.62 | default identity |
| `--accent-2` | `#8e2f3c` | `#a8434f` | 7.21 / 2.61 | secondary identity |
| `--neutral` | `#8a8f96` | `#6b6f76` | 2.93 / 3.03 | neutral marks |
| `--ok` | `#457245` | `#6fa36f` | 5.05 / 5.21 | success |
| `--warn` | `#8a6a1f` | `#c9a24a` | 4.54 / 6.38 | waiting |
| `--bad` | `#8e3b3b` | `#d38484` | 7.40 / 5.40 | error |

`--line-strong` is for control boundaries and slider tracks only; `--line` is for
surfaces. The prescribed hexes measure 3.05:1 on light `--bg` `#f4f3ef` and
3.39:1 on light `--card` `#ffffff`; in dark mode 4.15:1 on `--bg` `#16171b` and
3.55:1 on `--card` `#23252b`. Each clears the 3:1 non-text contrast minimum in
WCAG 1.4.11, so a boundary or slider track drawn with `--line-strong` passes on
either surface. `--line` stays the decorative hairline for card edges. Do not
rely on the track alone to signal a control: the accent thumb, border and label
still carry the state.

Scales: `--space-1..6` = 4/8/12/16/24/32px; `--radius-sm` = 6px,
`--radius-md` = 10px, `--radius-pill` = 999px; `--control-h` = 28px;
`--focus-ring` = `2px solid var(--accent)` with `--focus-offset` (2px) and
`--focus-offset-wide` (4px); `--text-xs/sm/md/lg` = 11/12/13/16px;
`--ease` = `cubic-bezier(.2,.7,.3,1)`; `--dur` = 150ms.

## Product identity contract

A package sets **only** `--accent` (and optionally `--accent-2`) as a
`light-dark()` pair in its own stylesheet, on `:root`, loaded after
`tokens.css`. No other kit token may be redefined. These pairs are
contrast-checked; use them as given. The rule for a new pair is: the light value
at least 4.5:1 on `#f4f3ef`, the dark value at least 4.5:1 on `#23252b`.

| Package | `--accent` pair | Light on bg | Dark on card |
| --- | --- | --- | --- |
| audio-normalizer | `light-dark(#9e521d, #df8f4d)` | 5.14:1 | 5.96:1 |
| slowed-reverb | `light-dark(#5b4a93, #a99ade)` | 6.65:1 | 6.10:1 |
| crunchy-presence | `light-dark(#a84b0d, #f47521)` | 5.14:1 | 5.41:1 |
| youtube-music-presence | `light-dark(#a03a4a, #e08c9c)` | 5.91:1 | 6.13:1 |
| presence-suite | `light-dark(#3f5fa8, #8ea9e8)` | 5.54:1 | 6.56:1 |

`.btn-primary` is filled with `--accent` and white text **only** where that
reaches 4.5:1. Every light value above does (5.71-7.38:1); none of the dark
values do (2.34-2.83:1), so in dark mode the fill becomes a 24% tint of the
accent in `--card` and the label becomes `--ink` (8.19-9.04:1 on those tints).

## Component anatomy

Shell - popup 320px; options the same grid up to 560px:

```html
<main class="popup"> ... </main>
<main class="popup options"> ... </main>
```

Header - 24px art tile (the icon carries its own colour), title, pill:

```html
<header><img src="icons/icon24.png" alt="" width="24" height="24">
  <h1>Name</h1><span class="pill" data-tone="connected">On</span></header>
```

`data-tone` is `connected|waiting|error|off`; legacy `data-state` values
(`connected|connecting|idle|unknown|error|disconnected|off`) still work.

Card - title, now line, muted detail and muted reason (`[hidden]` respected):

```html
<section class="card"><h2 class="source-name">Title</h2>
  <p class="now">Playing</p><p class="detail">Artist</p>
  <p class="reason" hidden></p></section>
```

Source list:

```html
<ul class="sources"><li class="source card">
  <h2 class="source-name">Source</h2><p class="now">Playing</p></li></ul>
```

Switch - one CSS-drawn implementation, checked and disabled states supported:

```html
<label class="toggle"><input type="checkbox" role="switch" checked>
  <span>Active</span></label>
```

Slider - 6px `--line-strong` track, 18px accent thumb, readout pair:

```html
<p class="readout">1.00x</p>
<input type="range" min="0" max="1" step="0.01" value="1" aria-label="Level">
<p class="readout-sm">100%</p>
```

Field - label with text input or textarea:

```html
<label class="field"><span>Application ID</span>
  <input type="text" inputmode="numeric"></label>
```

Buttons - quiet secondary and the single filled primary:

```html
<button type="button" class="btn">Reset</button>
<button type="submit" class="btn-primary">Save</button>
```

Footer - right-aligned link or button:

```html
<footer><a href="options.html">Settings</a></footer>
```

## House rules

- Flat surfaces: no shadows, no gradients, no decorative borders.
- One accent per product: `--accent` only; never colour a second control family.
- 24px minimum interactive targets; controls use `--control-h` where relevant.
- Visible focus on every interactive element via `:focus-visible`; never remove the outline.
- `prefers-reduced-motion` removes switch and thumb transitions.
- `forced-colors: active` keeps borders and the switch thumb on `CanvasText`/`Highlight`.
- `prefers-contrast: more` strengthens control borders to `--line-strong`.

## Add a new extension

1. Copy a popup skeleton and link both stylesheets **before** your own stylesheet:

   ```html
   <meta name="color-scheme" content="light dark">
   <link rel="stylesheet" href="ui-kit/tokens.css">
   <link rel="stylesheet" href="ui-kit/components.css">
   <link rel="stylesheet" href="popup.css">
   ```

2. Create `packages/<name>/ui-kit/` and set your `light-dark()` `--accent` pair
   on `:root` in your own stylesheet. Do not redefine kit tokens or kit classes.
3. Run `node scripts/ui-kit-sync.mjs`, then `node scripts/ui-kit-check.mjs`.

The sync script is a **dev tool, not a bundler and not a build step**: it copies
the two CSS files byte-for-byte into existing `ui-kit/` directories and prints
what it wrote. The copies are committed; no extension fetches or builds them.

## Eyeball procedure

Open `packages/ui-kit/preview.html` directly (`file://` works - relative
`tokens.css` and `components.css`, no scripts). Check all four frames:
light/dark at popup 320px and options 560px. For a saved comparison, screenshot
it with the hand browser at those two widths in both schemes. The page is never
included in an extension zip.
