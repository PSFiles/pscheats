# PS Cheats

PS3 / PS4 / PS5 / PS Vita cheat collection — this repository is the root of the site and also
holds the data synced from the four upstream repositories that publish those cheats.

Site: <https://psfiles.github.io/pscheats/>

## Layout

| Folder | Contents | Upstream |
| --- | --- | --- |
| `PS3-game-cheats/` | `SERIAL.txt` | [mohasi/game-cheats](https://github.com/mohasi/game-cheats) (`compiled/`) |
| `PS3-ArtemisDB/` | `Title SERIAL.ncl` | [bucanero/ArtemisPS3](https://github.com/bucanero/ArtemisPS3/tree/master/docs/codes) (`docs/codes/`) + `.ncl` generated from `PS3-game-cheats/` |
| `PS4-GoldHEN/` | `CUSAxxxxx_01.00.json` | [GoldHEN/GoldHEN_Cheat_Repository](https://github.com/GoldHEN/GoldHEN_Cheat_Repository) (`json/`) |
| `PS5-HEN/` | `CUSAxxxxx_01.00_hash.json` | [TeeKay87/HEN-Cheats-Collection](https://github.com/TeeKay87/HEN-Cheats-Collection) (`cheats/json/`) |
| `PSV-vitacheats/` | `PCSAxxxxx.psv` (VitaCheat) | **local** folder — there is no upstream repository to sync from |

The first four folders mirror the upstream repositories; `PSV-vitacheats/` is maintained by hand
(the sync script never writes to it — it is only indexed by the site). Each cheat's author is
credited in the author field of its own file.

- `index.html`, `assets/` — the site (HTML/CSS/JS, no dependencies, no server-side code).
- `tools/build-site.mjs` — reads the folders above and generates the search index plus one JSON
  file per game.
- `.github/workflows/pages.yml` — on every push to `main`, builds the site and deploys it to
  GitHub Pages.

The site is fully static: searching, filtering and opening a game never call an external API.
The whole index (~1 MB compressed) is downloaded once and each game's codes are fetched on
demand.

## Updating the cheats

The updater lives **outside** this repository, in the project folder
(`Update-GameCheats.ps1` + `Update-GameCheats.cmd`).

```powershell
# check all four sources, download only what changed, rebuild ArtemisDB and the site
.\Update-GameCheats.ps1

# sync, rebuild the site and publish (commit + push -> GitHub Pages redeploys)
.\Update-GameCheats.ps1 -Publish

# PS4 (GoldHEN) only, revalidating every file by hash
.\Update-GameCheats.ps1 -Only goldhen -Force

# dry run, changes nothing
.\Update-GameCheats.ps1 -WhatIf
```

The script keeps its state in `pscheats.sync` (next to the `.ps1`): when no upstream commit has
changed, the run finishes in seconds.

## Running the site locally

```powershell
cd Cheats
node tools/build-site.mjs --serve 8080
# open http://127.0.0.1:8080/
```

Opening `index.html` directly over `file://` does not work (the browser blocks the JSON
`fetch` calls); use the server above.

## Publishing to GitHub Pages

1. `git init`, commit and push to a public repository (Pages is free for public repositories).
2. In **Settings → Pages**, set **Source: GitHub Actions**.
3. The first push to `main` runs the workflow and publishes the site at
   `https://<user>.github.io/<repository>/`.

## Credits

All cheats belong to their authors and to the projects that maintain them: mohasi,
bucanero (ArtemisPS3), GoldHEN, TeeKay87 and the communities contributing to those
repositories. This repository only consolidates and indexes that data.
