# Changelog

## [0.8.0](https://github.com/karyl-chan/plugin-radio/compare/v0.7.1...v0.8.0) (2026-10-25)


### Features

* adopt plugin SDK 0.16 and gate image publishes ([5e942c9](https://github.com/karyl-chan/plugin-radio/commit/5e942c975ad4fa906afac26af2181d249eac7138))
* adopt plugin SDK 0.16 typed RPC ([d3ee4d7](https://github.com/karyl-chan/plugin-radio/commit/d3ee4d77d495d0ca59bee9bfe4338b2a0ff4c754))
* **api-keys:** persistent API keys for the external control channel ([57e54f7](https://github.com/karyl-chan/plugin-radio/commit/57e54f7f94091490b9d12fe170bf30d96e3c725c))
* **db:** per-user personal playlists store (schema v3) ([3b3c4e4](https://github.com/karyl-chan/plugin-radio/commit/3b3c4e4d888399db9471fb64d5a3aed7a8eaaa62))
* **ext-routes:** external control channel /api/ext/* (key-authed) ([7128bc5](https://github.com/karyl-chan/plugin-radio/commit/7128bc5770097269100753161df727cbf3cf0ec1))
* **ext-routes:** rich status (presence+session), loop/autoplay, scopes ([d139482](https://github.com/karyl-chan/plugin-radio/commit/d1394820b783ecb6a373e57a5f7305f83e2919fc))
* **favorites:** per-user favorites store + /api/me/favorites routes ([67ebb68](https://github.com/karyl-chan/plugin-radio/commit/67ebb68d3d911178e0fe983e9866621fb1b673f7))
* **i18n:** three-locale support (en / zh-TW / zh-CN) end-to-end ([274d8fc](https://github.com/karyl-chan/plugin-radio/commit/274d8fcd68d42a752e981897724d7201cba7612f))
* manage via bot admin UI link; serve manage SPA at /manage ([f51a17b](https://github.com/karyl-chan/plugin-radio/commit/f51a17b19058ddc40642e47bcb33028d84fa5d5d))
* **personal:** /api/me routes + /radio me link (personal page backend) ([b7fba29](https://github.com/karyl-chan/plugin-radio/commit/b7fba29760d74b7a38e5596ca782f8feaeda0d09))
* **shuffle:** /radio play shuffle param + /radio shuffle toggle + WebUI ([84882e8](https://github.com/karyl-chan/plugin-radio/commit/84882e89f1e5641030c9395b5b0d6d31b3d14e2f))
* **web:** adopt @karyl-chan/ui 0.4.0 &lt;Stack&gt; layout in the tab views ([102f3e2](https://github.com/karyl-chan/plugin-radio/commit/102f3e22d591cbba905b0276d4d7c8313f45bbe8))
* **web:** personal page (/me) — my playlists + API keys + Play ([3e82163](https://github.com/karyl-chan/plugin-radio/commit/3e82163e59dd16d608a658abef7b2b2899d4cef9))
* **webui:** add-to-queue cold-starts when the bot isn't in voice ([7959a5b](https://github.com/karyl-chan/plugin-radio/commit/7959a5b6e6812d9bd1f868f3e536c520c52706d7))
* **webui:** animate the identity avatar on hover only ([f5bc9c7](https://github.com/karyl-chan/plugin-radio/commit/f5bc9c74ac767c18ea48db39fd33a9f8f8f30669))
* **webui:** API Keys tab to manage external-control keys ([1259109](https://github.com/karyl-chan/plugin-radio/commit/1259109fec32ecd1d05c9ce615ca8739e4ff09e9))
* **webui:** favorites — ☆ toggle, add-to-queue autocomplete, save queue, /me tab ([cc9d403](https://github.com/karyl-chan/plugin-radio/commit/cc9d4039b20a8a41b8dc64b73dd6120fae0f5e8e))
* **webui:** logged-in identity chip + personal-page polish ([0c44ba9](https://github.com/karyl-chan/plugin-radio/commit/0c44ba989dd03f16a3e43993b16dd141e5e757ad))
* **webui:** make the identity chip link to the personal page ([bafee6a](https://github.com/karyl-chan/plugin-radio/commit/bafee6af889c59f97da81d4152e42315d68dcbfd))
* **webui:** one login shared by /me and the player; still avatar by default ([967eb0a](https://github.com/karyl-chan/plugin-radio/commit/967eb0a266e9c9d34155dd74b152c0207cdc210b))


### Bug Fixes

* **queue:** /radio play (and WebUI/ext play) fully resets the playlist ([1626e83](https://github.com/karyl-chan/plugin-radio/commit/1626e8364a997f4f9bf2f730d0e6c4dfa74d3281))
* **radio:** self-update yt-dlp so YouTube streams stop 403-ing ([#1](https://github.com/karyl-chan/plugin-radio/issues/1)) ([49eafae](https://github.com/karyl-chan/plugin-radio/commit/49eafae778f0808fb8cf0ec3d1d3ab3bdd3381c0))
* **radio:** store covers host-independent so they survive URL/proxy changes ([a5573ca](https://github.com/karyl-chan/plugin-radio/commit/a5573ca7ea4297fb8bd79dfcc530a25baf8b4205))
* **radio:** unset RADIO_YTDLP_UPDATE_HOURS disabled yt-dlp self-update ([#2](https://github.com/karyl-chan/plugin-radio/issues/2)) ([32f8f85](https://github.com/karyl-chan/plugin-radio/commit/32f8f859cba0adde75289dd3b8641be8cc024d90))
* **stop:** WebUI stop button no longer 500s (resilient doStop) ([36079a7](https://github.com/karyl-chan/plugin-radio/commit/36079a755c95dfd159904f6e16b7804c42971968))
* **webui:** re-enable "Open player" after returning via back button ([9f2b966](https://github.com/karyl-chan/plugin-radio/commit/9f2b9666e9c96b4686cf4a58e730727202ea6ada))
* **webui:** restore body scroll, fix ManageView bottom-alignment ([90bfc9a](https://github.com/karyl-chan/plugin-radio/commit/90bfc9a0ea1fb84bdcb0178b1d14591aed37f01c))
