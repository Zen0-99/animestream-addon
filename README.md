# AnimeStream Addon (Self-Host Edition)

A Stremio addon providing anime catalogs, metadata, AniList/MAL sync, subtitles, **and streaming** (HTTPS + torrents + debrid).

> **Note:** This branch includes streaming capabilities that were removed from the main branch (v1.5.1+) due to reliability issues when shared across many users. **Self-hosting solves most of those issues** because you're the only user - no shared rate limits, no IP bans from other people's usage.

---

## Table of Contents

- [What You Need](#what-you-need)
- [Step 1: Install Prerequisites](#step-1-install-prerequisites)
- [Step 2: Get the Code](#step-2-get-the-code)
- [Step 3: Create a Cloudflare Account](#step-3-create-a-cloudflare-account)
- [Step 4: Create KV Namespaces](#step-4-create-kv-namespaces)
- [Step 5: Configure wrangler.toml](#step-5-configure-wranglertoml)
- [Step 6: Upload Catalog Data](#step-6-upload-catalog-data)
- [Step 7: Deploy the Worker](#step-7-deploy-the-worker)
- [Step 8: (Optional) Deploy Proxy Workers](#step-8-optional-deploy-proxy-workers)
- [Step 9: Install in Stremio](#step-9-install-in-stremio)
- [Streaming Configuration](#streaming-configuration)
- [Updating the Catalog](#updating-the-catalog)
- [Troubleshooting](#troubleshooting)
- [Features](#features)

---

## What You Need

- A computer with **Node.js 18+** installed (check with `node --version`)
- A free **Cloudflare** account (we'll create one below)
- About **30 minutes** of setup time
- A **debrid service** subscription (optional but recommended for torrent streaming - e.g. Real-Debrid, AllDebrid, TorBox)

No coding experience required. Follow the steps in order.

---

## Step 1: Install Prerequisites

### Install Node.js

1. Go to https://nodejs.org/
2. Download the **LTS version** (the green button)
3. Run the installer with default settings
4. Verify it works by opening a terminal (Command Prompt / PowerShell / Terminal) and typing:
   ```bash
   node --version
   ```
   You should see something like `v22.x.x`.

### Install Git (if you don't have it)

1. Go to https://git-scm.com/downloads
2. Download and install with default settings
3. Verify:
   ```bash
   git --version
   ```

---

## Step 2: Get the Code

Open a terminal and run:

```bash
# Download the code
git clone https://github.com/Zen0-99/animestream-addon.git
cd animestream-addon

# Switch to the self-host branch (with streaming)
git checkout self-host

# Install dependencies
npm install
```

---

## Step 3: Create a Cloudflare Account

1. Go to https://dash.cloudflare.com/sign-up
2. Sign up with your email (free tier is fine - 100,000 requests/day)
3. Verify your email address

### Install Wrangler (Cloudflare's deployment tool)

In your terminal:
```bash
npm install -g wrangler
```

### Log in to Cloudflare

```bash
wrangler login
```

This opens a browser window. Click **"Allow"** to authorize Wrangler with your Cloudflare account.

---

## Step 4: Create KV Namespaces

KV (Key-Value) storage is where the addon stores catalog data and user tokens. You need two namespaces.

In your terminal, run:

```bash
cd cloudflare-worker

# Create the USER_TOKENS namespace (stores AniList/MAL auth tokens)
wrangler kv namespace create USER_TOKENS
```

You'll see output like:
```
[[kv_namespaces]]
binding = "USER_TOKENS"
id = "abc123def456..."
```

**Copy the `id` value** - you'll need it in Step 5.

```bash
# Create the API_CACHE namespace (stores catalog data and API response cache)
wrangler kv namespace create API_CACHE
```

Again, **copy the `id` value**.

---

## Step 5: Configure wrangler.toml

Open `cloudflare-worker/wrangler.toml` in a text editor (Notepad, VS Code, etc.).

Replace the two `id = "..."` lines with the IDs you got from Step 4:

```toml
name = "animestream-addon"
main = "worker-github.js"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"

[[kv_namespaces]]
binding = "USER_TOKENS"
id = "YOUR_USER_TOKENS_ID_HERE"

[[kv_namespaces]]
binding = "API_CACHE"
id = "YOUR_API_CACHE_ID_HERE"
```

Save the file.

---

## Step 6: Upload Catalog Data

The addon needs catalog data (7,000+ anime with metadata). It's included in the `data/` folder.

Upload it to your KV namespace:

```bash
# Make sure you're in the cloudflare-worker directory
cd cloudflare-worker

# Upload catalog and filter options to KV
node upload-to-kv.js catalog filters
```

This takes 1-2 minutes. You should see "All uploads complete!" at the end.

> **Note:** If you get an error about `CLOUDFLARE_API_TOKEN`, make sure you ran `wrangler login` in Step 3.

---

## Step 7: Deploy the Worker

```bash
# Still in the cloudflare-worker directory
npx wrangler deploy
```

You'll see output like:
```
Deployed animestream-addon triggers
  https://animestream-addon.<your-subdomain>.workers.dev
```

**Copy this URL** - this is your addon's address. The manifest URL is:
```
https://animestream-addon.<your-subdomain>.workers.dev/manifest.json
```

---

## Step 8: (Optional) Deploy Proxy Workers

> **Skip this step if:** you're the only user, or you don't plan to use HTTPS streaming (torrents/debrid work fine without it)

AllAnime (the HTTPS streaming source) rate-limits by IP. When self-hosting for just yourself, you usually won't hit rate limits. But if you do, proxy workers on separate Cloudflare accounts can help.

See the detailed guide: [`cloudflare-worker/deploy-proxies.md`](cloudflare-worker/deploy-proxies.md)

To enable proxies after deploying them, add to `wrangler.toml`:
```toml
[vars]
PROXY_URLS = "https://animestream-proxy-1.acct1.workers.dev,https://animestream-proxy-2.acct2.workers.dev"
```
Then redeploy: `npx wrangler deploy`

---

## Step 9: Install in Stremio

1. Open Stremio (desktop or web at https://web.stremio.com)
2. Go to **Addons** → search box in top right
3. Paste your manifest URL:
   ```
   https://animestream-addon.<your-subdomain>.workers.dev/manifest.json
   ```
4. Click **Install**
5. Configure your settings on the configure page:
   - **Catalog Config**: Choose which catalogs to show, connect AniList/MAL
   - **Streaming Config**: Choose stream mode (HTTPS / Torrents / Both), enter debrid API key if using debrid

### Getting a Debrid API Key (for torrent streaming)

If you want torrent streams with instant playback (no waiting for downloads):

1. Sign up for a debrid service:
   - **Real-Debrid**: https://real-debrid.com/ (~$3/month)
   - **AllDebrid**: https://alldebrid.com/ (~$3/month)
   - **TorBox**: https://torbox.app/ (cheaper option)
2. Get your API key from the service's settings/dashboard
3. Paste it into the "API Key" field in the Streaming Config tab
4. Click **Validate** to verify it works

---

## Streaming Configuration

The configure page has two tabs:

### Catalog Config
- **Show counts**: Display item counts on genre/season filters
- **Exclude long-running**: Hide One Piece, Detective Conan, etc. from "Currently Airing"
- **Content Origin**: Filter by country (Japan, China, Korea, Taiwan)
- **Minimum Episode Runtime**: Hide short-form content (music videos, 3-min episodes)
- **Connect Accounts**: Log in to AniList/MAL for scrobbling and personal list catalogs
- **Choose Catalogs**: Select which catalogs appear in Stremio

### Streaming Config
- **Stream Mode**:
  - **HTTPS Only**: Direct streaming from embed sources (may be unreliable)
  - **Torrents Only**: Magnet links + debrid resolution (recommended)
  - **Both**: Show all available streams
- **Debrid Provider**: Select your debrid service and enter API key
- **Torrent Preferences**: Filter by quality (4K/1080p/720p), audio type (RAW/SUB/DUB/DUAL), max results, min seeders, min size

---

## Updating the Catalog

The catalog is updated weekly via GitHub Actions (runs every Sunday). If you self-host, you have two options:

### Option A: Manual update (recommended for self-hosters)

```bash
# Fetch current season anime and update airing status
node scripts/fetch-season.js

# Regenerate filter options (genre/season counts)
node scripts/update-filter-options.js

# Upload to KV
cd cloudflare-worker
node upload-to-kv.js catalog filters

# Redeploy worker
npx wrangler deploy
```

### Option B: Set up your own GitHub Actions

Fork the repo, enable Actions in your fork settings, and add these secrets:
- `CLOUDFLARE_API_TOKEN`: Create at https://dash.cloudflare.com/profile/api-tokens (use "Edit Cloudflare Workers" template)
- `CLOUDFLARE_ACCOUNT_ID`: Found in your Cloudflare dashboard (right sidebar)

The weekly action will automatically update the catalog and redeploy.

---

## Troubleshooting

### "wrangler login" opens a blank page
Try running `wrangler login` again, or use an API token instead:
1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Create a token using the "Edit Cloudflare Workers" template
3. Set environment variables:
   ```bash
   # Windows (PowerShell)
   $env:CLOUDFLARE_API_TOKEN = "your-token-here"
   $env:CLOUDFLARE_ACCOUNT_ID = "your-account-id"
   
   # Mac/Linux
   export CLOUDFLARE_API_TOKEN="your-token-here"
   export CLOUDFLARE_ACCOUNT_ID="your-account-id"
   ```

### Streams not appearing
- **HTTPS streams**: The embed sources may be down or rate-limited. Try again later, or switch to Torrents mode.
- **Torrent streams**: Make sure you have a debrid provider configured and validated. Without debrid, you'll get raw magnet links (requires a torrent client).
- **No streams at all**: Check that the anime exists in the catalog. Some obscure titles may not have streams available.

### "Failed to fetch: Load failed" on AniList/MAL catalogs
- Make sure you've connected your AniList/MAL account in the configure page
- Try disconnecting and reconnecting
- Check that your token hasn't expired (re-login)

### Worker returns 429 (Too Many Requests)
You're hitting the rate limit. Wait a few seconds and try again. If it persists:
- Deploy proxy workers (Step 8)
- Reduce the number of catalogs you're using

### Catalog is empty / "Loading..." forever
- Make sure you uploaded the catalog data (Step 6)
- Check that your KV namespace IDs in `wrangler.toml` are correct
- Verify with: `wrangler kv key list --namespace-id=YOUR_API_CACHE_ID`

### Debrid validation fails
- Double-check your API key (no spaces, correct provider selected)
- For AllDebrid: keys are case-sensitive
- Try generating a new API key from your debrid service's dashboard

---

## Features

### Catalogs
- **Top Rated**: Highest rated anime from the database
- **Season Releases**: Anime from current and past seasons
- **Currently Airing**: Anime currently broadcasting
- **Movies**: Anime movies
- **AniList Lists**: Your personal AniList lists (Watching, Completed, Planning, etc.)
- **MAL Lists**: Your MyAnimeList lists

### Streaming
- **HTTPS Streams**: Direct streaming from embed providers (SUB/DUB)
- **Torrent Streams**: Magnet links with tracker support
- **Debrid Integration**: 8 providers supported (Real-Debrid, AllDebrid, TorBox, Premiumize, Debrid-Link, EasyDebrid, Offcloud, Put.io)
- **Smart File Selection**: Auto-selects the correct file from batch torrents using file index and episode matching
- **Quality/Audio Filtering**: Filter by resolution (4K/1080p/720p) and audio type (RAW/SUB/DUB/DUAL)

### Metadata & Sync
- Full anime metadata (episodes, descriptions, posters, ratings)
- AniList/MAL scrobbling (auto-mark episodes as watched)
- ID mapping across AniList, MAL, Kitsu, and IMDb

### Subtitles
- Kitsunekko (anime-specialized subtitle source)
- OpenSubtitles
- SubDL (with API key)

---

## License

MIT
