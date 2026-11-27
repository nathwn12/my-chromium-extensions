// ui-kit/switch.js - conditional switch-polyfill loader.
// Load as a module: <script type="module" src="../ui-kit/switch.js"></script>
// The polyfill is not bundled: a browser without native <input switch> asks
// for the package and keeps the plain checkbox when that import fails.
if (!("switch" in HTMLInputElement.prototype)) {
  import("input-switch-polyfill").catch(function () {});
}
