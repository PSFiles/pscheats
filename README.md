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
- `tools/serials.json` — curated map for the few cheat files that carry no title id in the name;
  `tools/resolve-serials.mjs` proposes its entries.
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

## Files without a title id

Most cheat files name the game id (`Bayonetta BLES00599 01.00.ncl`), but some upstream ArtemisPS3
files do not (`Bayonetta.ncl`). Without an id those cheats cannot be grouped with the game they
belong to, so `tools/serials.json` maps the file name to the id(s) it covers:

```json
{
  "Bayonetta.ncl": ["BLES00599", "BLUS30367"],
  "Daytona USA 01.00.ncl": null
}
```

The first id is the primary one — it decides which game page the cheats land on (Europe and
America are preferred). `null` means "not identified yet": the build ignores it and keeps the
game as a standalone entry.

```powershell
# propose entries by matching the title against files that do carry an id
node tools/resolve-serials.mjs --suggest

# report only, writes nothing
node tools/resolve-serials.mjs --dry-run
```

Proposals never overwrite an existing non-empty entry, so manual work is safe. The build prints
map entries that no longer match any file (upstream renamed it) and drops `titles.json` keys that
no longer belong to a game — pass `--keep-orphans` to keep them.

Game names are cleaned automatically, wherever they come from (file name, `# Title` header or
`titles.json`): the title id, the version (`v01.00`, `av01.14`, `tv01.28`), a bare region prefix
(`BLES`, `NPUB`, `NPHB`…) and a trailing region word (`JPN`, `NTSC PAL`) are removed. When a file
name lists several ids (`Killzone 3 BCES01007 BCUS98234.ncl`) the first one owns the page and the
others stay searchable.

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
