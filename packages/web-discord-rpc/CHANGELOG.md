# Changelog

Notable changes to this package. Dates are ISO 8601. This package is local-only and is not published to a registry.

## [Unreleased]

- The default transport is now `ipc`: presence goes to the installed Discord desktop app over its local socket, with no fallback. `auto` and `arrpc` stay selectable in Settings and are marked deferred, because both reach the Discord Web path the owner has deferred.
- The extension is named Discord RPC in the manifest, the popup, the settings page, and every doc; the package path `packages/web-discord-rpc`, the storage keys, the host name, and the extension ID are unchanged.

## [1.0.0] - 2026-11-10

- You can now see YouTube and YouTube Music in Discord at the same time: watching a video shows a WATCHING card titled YouTube, listening shows a LISTENING card titled YouTube Music, and one app install covers both.
- Discord desktop is tried first. If the desktop app is not running, presence quietly uses arRPC/Vencord (Discord Web) instead and switches back on its own — you do not need to change a setting.
- A fresh install works with no setup: the built-in app is used unless you saved your own 17–20 digit application ID, which you can clear at any time to go back.
- If Discord is unreachable, the status reads Waiting with a plain explanation instead of an error; only a rejected application ID needs you to act.
- Your tabs stay private: nothing leaves this machine except Discord's own presence traffic, artwork is only handed to Discord as a link, and the video stream itself is never touched.
- If presence never appears: start the Discord desktop app (or arRPC for the web path), re-run the host installer with `--check`, and reload the extension.
