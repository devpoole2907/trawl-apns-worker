/**
 * trawl-apns-worker
 * A Cloudflare Worker proxy for Apple Push Notification service (APNs)
 * and a caching proxy for the TMDb API.
 */

export interface Env {
	APNS_KEY_ID: string;
	APNS_TEAM_ID: string;
	APNS_PRIVATE_KEY: string;
	APP_BUNDLE_ID: string;
	TMDB_API_KEY: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/tmdb/")) {
			return handleTMDb(request, url, env, ctx);
		}

		if (url.pathname === "/push") {
			return handlePush(request, env);
		}

		return new Response("Not Found", { status: 404 });
	},
};

async function handleTMDb(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "GET") {
		return new Response("Method Not Allowed", { status: 405 });
	}

	const cache = caches.default;
	const cacheKey = new Request(request.url, { method: "GET" });
	const cached = await cache.match(cacheKey);
	if (cached) return cached;

	// Strip /tmdb prefix, keep the rest of the path and any query params
	const tmdbPath = url.pathname.slice("/tmdb".length);
	const params = new URLSearchParams(url.search);
	params.set("api_key", env.TMDB_API_KEY);

	const upstream = await fetch(`https://api.themoviedb.org/3${tmdbPath}?${params}`);
	if (!upstream.ok) {
		return new Response(await upstream.text(), { status: upstream.status });
	}

	const response = new Response(upstream.body, {
		status: 200,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "public, max-age=3600",
		},
	});
	ctx.waitUntil(cache.put(cacheKey, response.clone()));
	return response;
}

async function handlePush(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405 });
	}

	const deviceToken = deviceTokenFromRequest(request);
	if (!deviceToken) {
		return new Response("Missing X-Trawl-Token header or Basic auth password", { status: 400 });
	}

	let payload: any;
	try {
		payload = await request.json();
	} catch {
		// Seerr surfaces the response body in its own logs, and Trawl reads those logs
		// back when a test push fails — so these strings are user-visible.
		return new Response("Could not read the webhook body as JSON.", { status: 400 });
	}

	// Some Seerr versions post the payload template double-encoded, as a JSON string
	// containing JSON. Unwrap one layer before giving up on it.
	if (typeof payload === "string") {
		try {
			payload = JSON.parse(payload);
		} catch {
			return new Response("Webhook body was a string, but not valid JSON.", { status: 400 });
		}
	}

	if (!payload || typeof payload !== "object") {
		return new Response("Webhook body must be a JSON object.", { status: 400 });
	}

	try {
		const notification = parseNotification(payload);

		const jwt = await generateAPNsJWT(env);

		let apnsResponse = await sendToAPNs(deviceToken, jwt, env.APP_BUNDLE_ID, notification, false);

		if (apnsResponse.status === 400) {
			const errorJson: any = await apnsResponse.clone().json();
			if (errorJson.reason === "BadDeviceToken") {
				apnsResponse = await sendToAPNs(deviceToken, jwt, env.APP_BUNDLE_ID, notification, true);
			}
		}

		if (apnsResponse.ok) {
			return new Response("Notification sent", { status: 200 });
		} else {
			const errorText = await apnsResponse.text();
			return new Response(`APNs rejected the push: ${errorText}`, { status: apnsResponse.status });
		}

	} catch (err: any) {
		return new Response(`The push worker failed to send this notification: ${err.message}`, { status: 500 });
	}
}

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

/**
 * What a webhook turns into, once parsed. `title`/`body` are what the user reads;
 * everything else shapes how the push behaves and where tapping it lands.
 */
export interface ParsedNotification {
	title: string;
	body: string;
	/** Sent alongside `aps` so the app can route the tap and enrich the in-app banner. */
	data: Record<string, string>;
	/** Groups related pushes so a request updating PENDING → APPROVED → AVAILABLE replaces itself. */
	collapseId?: string;
	threadId?: string;
	interruptionLevel: "passive" | "active" | "time-sensitive" | "critical";
	/** "error" makes the app render a red in-app banner instead of a green one. */
	style?: "error";
}

/**
 * Seerr (the unified Overseerr/Jellyseerr successor) fills the app's webhook template
 * with `{{notification_type}}`, which arrives here as `eventType`. The app registers
 * that template itself and enables every type, so all twelve of these can show up.
 */
const SEERR_EVENT_TYPES = new Set([
	"MEDIA_PENDING",
	"MEDIA_APPROVED",
	"MEDIA_AUTO_APPROVED",
	"MEDIA_AVAILABLE",
	"MEDIA_FAILED",
	"MEDIA_DECLINED",
	"MEDIA_AUTO_REQUESTED",
	"ISSUE_CREATED",
	"ISSUE_COMMENT",
	"ISSUE_RESOLVED",
	"ISSUE_REOPENED",
	"TEST_NOTIFICATION",
]);

/**
 * Template placeholders Seerr can't fill come through as the empty string, and on some
 * versions as the raw "{{token}}" itself. Both mean "absent".
 */
function field(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return typeof value === "number" ? String(value) : undefined;
	}
	const trimmed = value.trim();
	if (!trimmed || (trimmed.startsWith("{{") && trimmed.endsWith("}}"))) {
		return undefined;
	}
	return trimmed;
}

/** Turns MEDIA_AUTO_REQUESTED into "Media Auto Requested" for any type we don't know yet. */
function humanizeEventType(eventType: string): string {
	return eventType
		.toLowerCase()
		.split(/[_\s]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/**
 * Matching the known-types allowlist alone would send any type Seerr adds later back
 * down the generic path, where it surfaces as a raw enum. So fall back to the shape:
 * Seerr spells its types in SCREAMING_SNAKE (the Arrs use PascalCase — "Grab",
 * "HealthIssue" — so there's no overlap) and only Seerr's template carries these fields.
 */
function isSeerrEvent(eventType: string, payload: any): boolean {
	if (SEERR_EVENT_TYPES.has(eventType)) return true;
	if (!/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(eventType)) return false;
	return ["subject", "requestId", "issueId", "requestedBy", "mediaType"].some(
		(key) => field(payload[key]) !== undefined
	);
}

export function parseSeerrNotification(payload: any): ParsedNotification {
	const eventType: string = payload.eventType;
	const subject = field(payload.subject);
	const requestedBy = field(payload.requestedBy);
	const comment = field(payload.comment);
	const issueType = field(payload.issueType);
	const requestId = field(payload.requestId);
	const issueId = field(payload.issueId);
	const isIssue = eventType.startsWith("ISSUE_");

	if (eventType === "TEST_NOTIFICATION") {
		return {
			title: "Trawl Test",
			body: "Seerr is connected. 🚀",
			data: { eventType, deepLink: "trawl://seerr-requests" },
			interruptionLevel: "active",
			threadId: "seerr",
		};
	}

	// The media title makes the better headline; the event line reads as the body.
	// `message` is deliberately never used as the body — Seerr fills it with the full
	// plot synopsis, which iOS truncates into noise.
	const by = requestedBy ? ` · ${requestedBy}` : "";
	let body: string;
	let style: "error" | undefined;
	let interruptionLevel: ParsedNotification["interruptionLevel"] = "active";

	switch (eventType) {
		case "MEDIA_PENDING":
			body = `New request awaiting approval${by}`;
			interruptionLevel = "passive";
			break;
		case "MEDIA_APPROVED":
			body = `Request approved${by}`;
			break;
		case "MEDIA_AUTO_APPROVED":
			body = `Request automatically approved${by}`;
			break;
		case "MEDIA_AUTO_REQUESTED":
			body = `Automatically requested${by}`;
			interruptionLevel = "passive";
			break;
		case "MEDIA_AVAILABLE":
			body = `Now available to watch${by}`;
			break;
		case "MEDIA_DECLINED":
			body = `Request declined${by}`;
			style = "error";
			break;
		case "MEDIA_FAILED":
			body = `Request failed${by}`;
			style = "error";
			interruptionLevel = "time-sensitive";
			break;
		case "ISSUE_CREATED":
			body = `${issueType ? `${issueType} issue` : "Issue"} reported${by}${comment ? `: ${comment}` : ""}`;
			style = "error";
			break;
		case "ISSUE_COMMENT":
			body = comment ? `${requestedBy ?? "New"} commented: ${comment}` : `New comment on issue${by}`;
			interruptionLevel = "passive";
			break;
		case "ISSUE_RESOLVED":
			body = `Issue resolved${by}`;
			break;
		case "ISSUE_REOPENED":
			body = `Issue reopened${by}`;
			style = "error";
			break;
		default:
			// A type Seerr added after this was written still reads as English
			// rather than as a raw enum.
			body = field(payload.event) ?? humanizeEventType(eventType);
			break;
	}

	const data: Record<string, string> = {
		eventType,
		deepLink: isIssue ? "trawl://seerr-issue" : "trawl://seerr-requests",
	};
	if (subject) data.subject = subject;
	if (requestedBy) data.requestedBy = requestedBy;
	if (requestId) data.requestId = requestId;
	if (issueId) data.issueId = issueId;
	const tmdbId = field(payload.tmdbId);
	if (tmdbId) data.tmdbId = tmdbId;
	const mediaType = field(payload.mediaType);
	if (mediaType) data.mediaType = mediaType;
	if (style) data.style = style;

	// Collapse on the underlying request/issue so its lifecycle updates one banner.
	const collapseId = isIssue
		? issueId && `seerr-issue-${issueId}`
		: requestId && `seerr-request-${requestId}`;

	return {
		title: subject ?? field(payload.event) ?? "Seerr",
		body,
		data,
		collapseId: collapseId || undefined,
		threadId: "seerr",
		interruptionLevel,
		style,
	};
}

export function parseNotification(payload: any): ParsedNotification {
	const eventType = field(payload.eventType) ?? "Notification";

	if (isSeerrEvent(eventType, payload)) {
		return parseSeerrNotification({ ...payload, eventType });
	}

	let title = eventType;
	let body = field(payload.message) ?? "Trawl Update";
	const data: Record<string, string> = { eventType };
	let style: "error" | undefined;
	let interruptionLevel: ParsedNotification["interruptionLevel"] = "time-sensitive";
	let collapseId: string | undefined;

	// 1. System Events
	if (eventType === "Test") {
		return {
			title: "Trawl Test",
			body: "Test notification successful! 🚀",
			data,
			interruptionLevel: "active",
		};
	}
	if (eventType === "ApplicationUpdate") {
		return {
			title: "System Update",
			body: `Updated to version ${field(payload.newVersion) ?? "latest"}`,
			data,
			interruptionLevel: "active",
		};
	}
	if (eventType === "HealthIssue") {
		return {
			title: "Health Alert",
			body: `${field(payload.level) ?? "Warning"}: ${payload.message}`,
			data: { ...data, style: "error" },
			interruptionLevel: "time-sensitive",
			style: "error",
		};
	}

	// 2. Radarr Events
	if (payload.movie) {
		const movieTitle = field(payload.movie.title) ?? "Movie";
		title = movieTitle;
		data.movieTitle = movieTitle;
		const releaseTitle = field(payload.release?.releaseTitle);
		if (releaseTitle) data.releaseTitle = releaseTitle;
		if (payload.movie.tmdbId) data.tmdbId = String(payload.movie.tmdbId);
		collapseId = payload.movie.id ? `radarr-movie-${payload.movie.id}` : undefined;

		switch (eventType) {
			case "Grab": body = `Grabbed: ${releaseTitle ?? "New Release"}`; break;
			case "Download": body = `Download Complete`; break;
			case "Rename": body = `Files Renamed`; break;
			case "MovieDelete": body = `Removed from library`; break;
			case "MovieFileDelete": body = `File deleted: ${field(payload.movieFile?.relativePath) ?? ""}`; break;
		}
	}

	// 3. Sonarr Events
	if (payload.series) {
		const seriesTitle = field(payload.series.title) ?? "Series";
		title = seriesTitle;
		data.seriesTitle = seriesTitle;
		const releaseTitle = field(payload.release?.releaseTitle);
		if (releaseTitle) data.releaseTitle = releaseTitle;
		collapseId = payload.series.id ? `sonarr-series-${payload.series.id}` : undefined;
		const epInfo = payload.episodes?.[0];
		const epCode = (epInfo?.seasonNumber !== undefined && epInfo?.episodeNumber !== undefined)
			? `S${epInfo.seasonNumber}E${epInfo.episodeNumber}`
			: "";
		const episodeTitle = field(epInfo?.title);
		if (episodeTitle) data.episodeTitle = episodeTitle;

		switch (eventType) {
			case "Grab": body = `Grabbed ${epCode}: ${releaseTitle ?? "New Release"}`; break;
			case "Download": body = `Download Complete ${epCode}`; break;
			case "Rename": body = `Files Renamed`; break;
			case "SeriesDelete": body = `Removed from library`; break;
			case "EpisodeFileDelete": body = `Episode deleted: ${epCode}`; break;
		}
	}

	if (payload.movie || payload.series) {
		data.deepLink = "trawl://downloads";
	}

	return { title, body, data, collapseId, interruptionLevel, style };
}

async function sendToAPNs(token: string, jwt: string, bundleId: string, notification: ParsedNotification, isSandbox: boolean) {
	const domain = isSandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com";
	const url = `https://${domain}/3/device/${token}`;

	const headers: Record<string, string> = {
		"authorization": `bearer ${jwt}`,
		"apns-topic": bundleId,
		"apns-push-type": "alert",
		// Only genuinely urgent events interrupt a Focus; the rest arrive quietly.
		"apns-priority": notification.interruptionLevel === "passive" ? "5" : "10",
	};
	if (notification.collapseId) {
		headers["apns-collapse-id"] = notification.collapseId;
	}

	const aps: Record<string, unknown> = {
		alert: { title: notification.title, body: notification.body },
		sound: "default",
		"interruption-level": notification.interruptionLevel,
	};
	if (notification.threadId) {
		aps["thread-id"] = notification.threadId;
	}

	return fetch(url, {
		method: "POST",
		headers,
		// `data` rides alongside `aps` so the app can route the tap and enrich its
		// in-app banner — it reads these keys out of userInfo.
		body: JSON.stringify({ aps, data: notification.data }),
	});
}

// Reuse the token for up to 50 minutes — APNs tokens are valid for 60 minutes and
// Apple rate-limits how often a provider can issue new ones (TooManyProviderTokenUpdates).
let cachedJWT: { token: string; issuedAt: number } | null = null;
const TOKEN_MAX_AGE_SECONDS = 50 * 60;

async function generateAPNsJWT(env: Env): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	if (cachedJWT && now - cachedJWT.issuedAt < TOKEN_MAX_AGE_SECONDS) {
		return cachedJWT.token;
	}

	const header = { alg: "ES256", kid: env.APNS_KEY_ID };
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

	const token = `${data}.${b64sig(signature)}`;
	cachedJWT = { token, issuedAt: now };
	return token;
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
