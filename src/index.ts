/**
 * trawl-apns-worker
 * A Cloudflare Worker proxy for Apple Push Notification service (APNs).
 */

export interface Env {
	// Secrets
	APNS_KEY_ID: string;
	APNS_TEAM_ID: string;
	APNS_PRIVATE_KEY: string; // The content of the .p8 file
	APP_BUNDLE_ID: string;    // e.g., com.poole.james.Trawl
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const url = new URL(request.url);
		if (url.pathname !== "/push") {
			return new Response("Not Found", { status: 404 });
		}

		// 1. Get Device Token from Header
		const deviceToken = request.headers.get("X-Trawl-Token");
		if (!deviceToken) {
			return new Response("Missing X-Trawl-Token header", { status: 400 });
		}

		try {
			// 2. Parse Webhook Payload (Radarr/Sonarr format)
			const payload: any = await request.json();
			
			// Extract title and body based on *arr webhook format
			const title = payload.eventType || "Trawl Notification";
			const body = payload.message || payload.title || "No message content";

			// 3. Generate APNs JWT
			const jwt = await generateAPNsJWT(env);

			// 4. Send to APNs
			// Note: Use 'api.push.apple.com' for production, 'api.sandbox.push.apple.com' for development
			const apnsUrl = `https://api.push.apple.com/3/device/${deviceToken}`;

			const response = await fetch(apnsUrl, {
				method: "POST",
				headers: {
					"authorization": `bearer ${jwt}`,
					"apns-topic": env.APP_BUNDLE_ID,
					"apns-push-type": "alert",
					"apns-priority": "10",
				},
				body: JSON.stringify({
					aps: {
						alert: {
							title: title,
							body: body,
						},
						sound: "default",
						"interruption-level": "time-sensitive"
					},
				}),
			});

			if (response.ok) {
				return new Response("Notification sent", { status: 200 });
			} else {
				const errorText = await response.text();
				return new Response(`APNs Error: ${errorText}`, { status: response.status });
			}

		} catch (err: any) {
			return new Response(`Server Error: ${err.message}`, { status: 500 });
		}
	},
};

/**
 * Generates a JWT for APNs authentication.
 * Uses Web Crypto API (supported by Cloudflare Workers).
 */
async function generateAPNsJWT(env: Env): Promise<string> {
	const header = {
		alg: "ES256",
		kid: env.APNS_KEY_ID,
	};

	const now = Math.floor(Date.now() / 1000);
	const claims = {
		iss: env.APNS_TEAM_ID,
		iat: now,
	};

	const encodedHeader = b64(JSON.stringify(header));
	const encodedClaims = b64(JSON.stringify(claims));
	const data = `${encodedHeader}.${encodedClaims}`;

	// Import the private key
	const pem = env.APNS_PRIVATE_KEY
		.replace(/-----BEGIN PRIVATE KEY-----/, "")
		.replace(/-----END PRIVATE KEY-----/, "")
		.replace(/\s/g, "");
	
	const binaryKey = str2ab(atob(pem));
	const key = await crypto.subtle.importKey(
		"pkcs8",
		binaryKey,
		{
			name: "ECDSA",
			namedCurve: "P-256",
		},
		false,
		["sign"]
	);

	const signature = await crypto.subtle.sign(
		{ name: "ECDSA", hash: { name: "SHA-256" } },
		key,
		new TextEncoder().encode(data)
	);

	return `${data}.${b64sig(signature)}`;
}

function b64(str: string): string {
	return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64sig(buf: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(buf)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function str2ab(str: string): ArrayBuffer {
	const buf = new ArrayBuffer(str.length);
	const bufView = new Uint8Array(buf);
	for (let i = 0, strLen = str.length; i < strLen; i++) {
		bufView[i] = str.charCodeAt(i);
	}
	return buf;
}
