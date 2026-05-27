# trawl-apns-worker

Cloudflare Worker that receives webhook payloads from Trawl-linked services and forwards them to Apple Push Notification service (APNs).

Production Worker:

```text
https://trawl-apns-worker.james-5d8.workers.dev
```

## Endpoint

Send webhooks to:

```text
POST /push
```

The Worker expects a JSON body and an APNs device token supplied by one of the supported auth methods below.

## Authentication

The Worker supports two token transports because the connected apps expose different webhook configuration surfaces.

For apps that support custom headers, send the APNs device token in `X-Trawl-Token`:

```text
X-Trawl-Token: <apns-device-token>
```

For Prowlarr, use Basic auth with `trawl` as the username and the APNs device token as the password:

```text
Authorization: Basic base64("trawl:<apns-device-token>")
```

Prowlarr uses Basic auth here because its webhook UI exposes username and password fields, rather than arbitrary custom headers.

## Payload Handling

The Worker reads the webhook `eventType` and formats a notification title/body before sending to APNs.

Handled system events:

- `Test`
- `ApplicationUpdate`
- `HealthIssue`

Handled media payloads:

- Radarr-style `movie` payloads
- Sonarr-style `series` and `episodes` payloads
- Generic fallback payloads with `eventType` and `message`

## Local Development

Install dependencies:

```sh
npm ci
```

Run tests:

```sh
npm test
```

Run locally with Wrangler:

```sh
npm run dev
```

Tests live in `test/index.spec.ts`.

## Cloudflare Secrets

Keep APNs credentials out of git. Configure them as Worker secrets:

```sh
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APNS_PRIVATE_KEY
npx wrangler secret put APP_BUNDLE_ID
```

`APNS_PRIVATE_KEY` should contain the full `.p8` private key contents.

Cloudflare documents Worker secrets here:

```text
https://developers.cloudflare.com/workers/configuration/secrets/
```

## Deploy

Deploy the Worker:

```sh
npm run deploy
```

Deploying requires either an active Wrangler login or a `CLOUDFLARE_API_TOKEN` in the environment.

Cloudflare documents Wrangler deploy commands here:

```text
https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy
```
