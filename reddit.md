# AnimeStream 1.5 — I'm back, and I brought fixes

Hey everyone. First off, I'm sorry for going dark for so long. Life happened, and the addon kind of fell off my radar. I've seen the bug reports here and on GitHub, and I want to thank those of you who took the time to report them. I've spent the last few days going through every issue and I'm finally pushing out a proper update.

## What's fixed

- **Wrong episodes playing** — This was the big one. Searching for Naruto would play Boruto, searching for Dragon Ball would play DBZ, etc. The show matching logic wasn't checking for sequel/spinoff names properly. Should be sorted now.
- **100GB+ torrents for single episodes** — Added a size cap so those massive full-series batches don't show up when you just want episode 4.
- **Split seasons / Part 2 not working** — Shows like AoT S4 Part 2, Sakamoto Days E12+ now auto-detect the Part 2 entry.
- **Multi-season anime not playing** — Initial D Second Stage and similar should work now.
- **Dub/sub filtering** — The audio type preferences (RAW, SUB, DUB, DUAL) actually filter now instead of being ignored.
- **Quality filtering** — Same deal with 1080p/720p/4K preferences — they work now.
- **Debrid error handling** — Instead of mysterious question marks on everything, you'll now get a clear message if your debrid API key is invalid.

## What's new

- **Content origin filter** — You can now filter the catalog by country of origin (Japan, China, Korea, Taiwan). If donghua isn't your thing, just select Japan only.
- **Minimum runtime filter** — Hide short-form content (3-minute episodes, music videos) from your browsing. Movies and search aren't affected.
- **KV caching** — Catalog and API responses are now cached in Cloudflare KV, which should mean faster cold starts and fewer failed requests.

## Links

- **Install:** https://animestream-addon.keypop3750.workers.dev/configure
- **GitHub:** https://github.com/Zen0-99/animestream-addon
- **Issues:** https://github.com/Zen0-99/animestream-addon/issues

If you run into anything, drop a comment here or open an issue on GitHub. I'll try to be more responsive this time around. Thanks for sticking with it.
