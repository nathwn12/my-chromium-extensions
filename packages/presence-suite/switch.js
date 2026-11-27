// ui-kit/switch.js — conditional switch-polyfill loader.
// Load as a module: <script type="module" src="switch.js"></script>
// Intentionally NOT bundled: the dynamic import is left in the shipped file so
// each consuming extension resolves/serves input-switch-polyfill itself.
// Browsers with native <input type="checkbox" switch> fetch nothing.
if (!('switch' in HTMLInputElement.prototype)) import('input-switch-polyfill');
