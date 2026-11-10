# Changelog

Notable changes to this package. Dates are ISO 8601. This package is local-only and is not published to a registry.

## [Unreleased]

- The default transport is now `ipc`: presence goes to the installed Discord desktop app over its local socket, with no fallback. `auto` and `arrpc` stay selectable in Settings and are marked deferred, because both reach the Discord Web path the owner has deferred.
- The extension is renamed YouTube Presence in the manifest, the popup, the settings page, and every doc, because it covers both YouTube and YouTube Music; the package path `packages/web-discord-rpc`, the storage keys, the host name, and the extension ID are unchanged.
- YouTube and YouTube Music get one independent toggle each, both on by default: `youtubeMusicEnabled` for Music and `youtubeEnabled` for YouTube. Either site works alone, switching one off leaves the other publishing, and YouTube Music is listed first in Settings. A site switched off reports itself as off instead of claiming nothing is playing.

## [1.0.1] - 2026-11-10

- Presence reaches Discord while the connection is still being set up: the worker hands desired activities to the host when it is `connecting` or `waiting` instead of only once connected, so a running Discord no longer leaves the status stuck at Waiting. The host announces itself on `hello`, and a missing desktop pipe reads "Discord is not running" rather than "Waiting for Discord to respond".
- YouTube Music is detected from any `music.youtube.com` page as soon as a title resolves, with no watch id required (it is null there); YouTube still requires a watch id.
- Docs are corrected to match, and assertions guard both claims.

## [1.0.0] - 2026-11-10

- You can now see YouTube and YouTube Music in Discord at the same time: watching a video shows a WATCHING card titled YouTube, listening shows a LISTENING card titled YouTube Music, and one app install covers both.
- Discord desktop is the default: presence goes to the installed app over its local socket. The arRPC/Vencord (Discord Web) route stays selectable as `auto` or `arrpc` and is deferred, not used automatically.
- A fresh install works with no setup: the built-in app is used unless you saved your own 17–20 digit application ID, which you can clear at any time to go back.
- If Discord is unreachable, the status reads Waiting with a plain explanation instead of an error; only a rejected application ID needs you to act.
- Your tabs stay private: nothing leaves this machine except Discord's own presence traffic, artwork is only handed to Discord as a link, and the video stream itself is never touched.
- If presence never appears: start the Discord desktop app (or arRPC for the web path), re-run the host installer with `--check`, and reload the extension.
