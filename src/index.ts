/**
 * trawl-apns-worker
 * A Cloudflare Worker proxy for Apple Push Notification service (APNs).
 */

export interface Env {
	APNS_KEY_ID: string;
	APNS_TEAM_ID: string;
	APNS_PRIVATE_KEY: string;
	APP_BUNDLE_ID: string;
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

		const deviceToken = deviceTokenFromRequest(request);
		if (!deviceToken) {
			return new Response("Missing X-Trawl-Token header or Basic auth password", { status: 400 });
		}

		try {
			const payload: any = await request.json();
			const { title, body } = parseNotification(payload);

			const jwt = await generateAPNsJWT(env);

			let apnsResponse = await sendToAPNs(deviceToken, jwt, env.APP_BUNDLE_ID, title, body, false);

			if (apnsResponse.status === 400) {
				const errorJson: any = await apnsResponse.clone().json();
				if (errorJson.reason === "BadDeviceToken") {
					apnsResponse = await sendToAPNs(deviceToken, jwt, env.APP_BUNDLE_ID, title, body, true);
				}
			}

			if (apnsResponse.ok) {
				return new Response("Notification sent", { status: 200 });
			} else {
				const errorText = await apnsResponse.text();
				return new Response(`APNs Error: ${errorText}`, { status: apnsResponse.status });
			}

		} catch (err: any) {
			return new Response(`Server Error: ${err.message}`, { status: 500 });
		}
	},
};

export function deviceTokenFromRequest(request: Request): string | null {
	const headerToken = request.headers.get("X-Trawl-Token")?.trim();
	if (headerToken) {
		return headerToken;
	}

	const authorization = request.headers.get("Authorization")?.trim();
	if (!authorization?.toLowerCase().startsWith("basic ")) {
		return null;
	}

	try {
		const credentials = atob(authorization.slice("basic ".length).trim());
		const separatorIndex = credentials.indexOf(":");
		if (separatorIndex < 0) {
			return null;
		}

		const username = credentials.slice(0, separatorIndex).trim().toLowerCase();
		const password = credentials.slice(separatorIndex + 1).trim();
		return username === "trawl" && password ? password : null;
	} catch {
		return null;
	}
}

export function parseNotification(payload: any): { title: string, body: string } {
	const eventType = payload.eventType || "Notification";
	let title = eventType;
	let body = payload.message || "Trawl Update";

	// 1. System Events
	if (eventType === "Test") return { title: "Trawl Test", body: "Test notification successful! 🚀" };
	if (eventType === "ApplicationUpdate") return { title: "System Update", body: `Updated to version ${payload.newVersion || "latest"}` };
	if (eventType === "HealthIssue") return { title: "Health Alert", body: `${payload.level || "Warning"}: ${payload.message}` };

	// 2. Radarr Events
	if (payload.movie) {
		const movieTitle = payload.movie.title || "Movie";
		title = movieTitle;

		switch (eventType) {
			case "Grab": body = `Grabbed: ${payload.release?.releaseTitle || "New Release"}`; break;
			case "Download": body = `Download Complete`; break;
			case "Rename": body = `Files Renamed`; break;
			case "MovieDelete": body = `Removed from library`; break;
			case "MovieFileDelete": body = `File deleted: ${payload.movieFile?.relativePath || ""}`; break;
		}
	}

	// 3. Sonarr Events
	if (payload.series) {
		const seriesTitle = payload.series.title || "Series";
		title = seriesTitle;
		const epInfo = payload.episodes?.[0];
		const epCode = (epInfo?.seasonNumber !== undefined && epInfo?.episodeNumber !== undefined) 
			? `S${epInfo.seasonNumber}E${epInfo.episodeNumber}` 
			: "";

		switch (eventType) {
			case "Grab": body = `Grabbed ${epCode}: ${payload.release?.releaseTitle || "New Release"}`; break;
			case "Download": body = `Download Complete ${epCode}`; break;
			case "Rename": body = `Files Renamed`; break;
			case "SeriesDelete": body = `Removed from library`; break;
			case "EpisodeFileDelete": body = `Episode deleted: ${epCode}`; break;
		}
	}

	return { title, body };
}

async function sendToAPNs(token: string, jwt: string, bundleId: string, title: string, body: string, isSandbox: boolean) {
	const domain = isSandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com";
	const url = `https://${domain}/3/device/${token}`;

	return fetch(url, {
		method: "POST",
		headers: {
			"authorization": `bearer ${jwt}`,
			"apns-topic": bundleId,
			"apns-push-type": "alert",
			"apns-priority": "10",
		},
		body: JSON.stringify({
			aps: {
				alert: { title, body },
				sound: "default",
				"interruption-level": "time-sensitive"
			},
		}),
	});
}

async function generateAPNsJWT(env: Env): Promise<string> {
	const header = { alg: "ES256", kid: env.APNS_KEY_ID };
	const now = Math.floor(Date.now() / 1000);
	const jwtClaims = { iss: env.APNS_TEAM_ID, iat: now };

	const encodedHeader = b64(JSON.stringify(header));
	const encodedClaims = b64(JSON.stringify(jwtClaims));
	const data = `${encodedHeader}.${encodedClaims}`;

	const pem = env.APNS_PRIVATE_KEY
		.replace(/-----BEGIN PRIVATE KEY-----/, "")
		.replace(/-----END PRIVATE KEY-----/, "")
		.replace(/\s/g, "");
	
	const binaryKey = str2ab(atob(pem));
	const key = await crypto.subtle.importKey(
		"pkcs8",
		binaryKey,
		{ name: "ECDSA", namedCurve: "P-256" },
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
