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

## Naming the server a push came from

Trawl also sends the name of the server the webhook belongs to:

```text
X-Trawl-Source: Radarr 4K
```

Without it, two servers of the same kind are indistinguishable on the lock screen:
an HD and a 4K Radarr both push "Download Complete" for the same film, and the
Arrs' own `instanceName` field is "Radarr" on every install unless the person
renamed it inside Radarr itself. The header carries the profile name chosen in
Trawl, so the label always matches what the app calls that server.

The Worker appends it to the body, puts it in `data.source`, and scopes collapse
ids by it — the two servers number their libraries independently, so movie 12
exists on both, and an unscoped collapse id let one server's push silently replace
the other's.

The header is optional. Prowlarr's webhook UI has no custom-header field, so its
pushes fall back to `instanceName`; a push with neither simply carries no label.

## Duplicate health alerts

One broken indexer is reported by every Arr that syncs from Prowlarr, and each of
them re-raises it on every recheck — a single failure produced nine banners in one
morning. Health pushes therefore share a collapse id keyed on the failing check's
`type` rather than on the server that noticed it, so every report of one fault
lands on one banner that updates in place. `HealthRestored` shares that key, so
the all-clear replaces the warning it answers rather than sitting beside it.

Collapsing is presentation only: each repeat still alerts. Suppressing the repeat
alerts would need the Worker to remember what it has already sent, which it
deliberately does not do.

## Payload Handling

The Worker reads the webhook `eventType` and formats a notification title/body before sending to APNs.

Handled system events:

- `Test`
- `ApplicationUpdate`
- `Health` / `HealthRestored`

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
