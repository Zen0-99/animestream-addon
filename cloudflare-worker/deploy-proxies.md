# Rotating Proxy Workers Setup

AllAnime rate-limits by egress IP. When multiple users access the addon simultaneously,
they share the same Cloudflare Worker egress IP, causing 429 "Too many requests" errors.

This guide explains how to deploy proxy workers on **separate Cloudflare accounts** to
distribute API requests across multiple egress IPs.

## Why separate accounts?

Cloudflare blocks worker-to-worker fetches within the same account (error 1042).
Proxy workers MUST be deployed on different Cloudflare accounts (free tier works).

## Step 1: Create additional Cloudflare accounts

Create 2-3 free Cloudflare accounts (different email addresses):
- https://dash.cloudflare.com/sign-up

You only need the Workers feature (free tier: 100k requests/day).

## Step 2: Deploy proxy workers

For each account, login with wrangler and deploy the proxy worker:

```bash
# Login to account 1 (different from main worker account)
npx wrangler login

# Deploy proxy worker 1
cd cloudflare-worker
npx wrangler deploy proxy-worker.js --name animestream-proxy-1 --compatibility-date 2024-01-01

# Note the URL: https://animestream-proxy-1.<account1-subdomain>.workers.dev
```

Repeat for each additional account:
```bash
# Login to account 2
npx wrangler login
npx wrangler deploy proxy-worker.js --name animestream-proxy-2 --compatibility-date 2024-01-01
# URL: https://animestream-proxy-2.<account2-subdomain>.workers.dev

# Login to account 3
npx wrangler login
npx wrangler deploy proxy-worker.js --name animestream-proxy-3 --compatibility-date 2024-01-01
# URL: https://animestream-proxy-3.<account3-subdomain>.workers.dev
```

## Step 3: Configure the main worker

Set the `PROXY_URLS` environment variable on the main worker:

**Option A: Via wrangler.toml**
```toml
[vars]
PROXY_URLS = "https://animestream-proxy-1.acct1.workers.dev,https://animestream-proxy-2.acct2.workers.dev,https://animestream-proxy-3.acct3.workers.dev"
```

Then redeploy:
```bash
npx wrangler deploy worker-github.js --name animestream-addon --compatibility-date 2024-01-01
```

**Option B: Via Cloudflare dashboard**
1. Go to Workers & Pages → animestream-addon → Settings → Variables
2. Add `PROXY_URLS` with the comma-separated proxy URLs
3. Save and deploy

## Step 4: Verify

Test that the proxy workers are accessible:
```bash
curl "https://animestream-proxy-1.acct1.workers.dev/?url=https%3A%2F%2Fapi.allanime.day%2Fapi%3Fvariables%3Dtest"
# Should return a JSON response (not error 1042)
```

Test that the main worker uses proxies on rate-limit:
```bash
curl "https://animestream-addon.<your-acct>.workers.dev/sm=https/stream/series/tt5626028:1:2.json"
```

Check the logs for `[AaStreams] ... via proxy:` messages:
```bash
npx wrangler tail --format pretty
```

## How it works

1. Main worker tries AllAnime API directly (fastest)
2. If 429 (rate-limited), it rotates to the next proxy worker
3. Each proxy worker exits through a different Cloudflare edge IP
4. If all proxies fail, it falls back to exponential backoff retry
5. Results are cached in KV for 5 minutes to reduce API calls

## Proxy worker security

The proxy worker (`proxy-worker.js`) only forwards requests to whitelisted hosts:
- `api.allanime.day`
- `allanime.to`
- `youtu-chan.com`

This prevents abuse of the proxy for arbitrary requests.
