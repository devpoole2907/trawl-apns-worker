import { describe, expect, it } from "vitest";
import { deviceTokenFromRequest, parseNotification, sourceFromRequest } from "../src/index";

describe("deviceTokenFromRequest", () => {
	it("uses the existing X-Trawl-Token header", () => {
		const request = new Request("https://worker.example/push", {
			method: "POST",
			headers: { "X-Trawl-Token": "header-token" },
		});

		expect(deviceTokenFromRequest(request)).toBe("header-token");
	});

	it("accepts Prowlarr Basic auth credentials", () => {
		const credentials = btoa("trawl:basic-token");
		const request = new Request("https://worker.example/push", {
			method: "POST",
			headers: { Authorization: `Basic ${credentials}` },
		});

		expect(deviceTokenFromRequest(request)).toBe("basic-token");
	});

	it("rejects Basic auth with another username", () => {
		const credentials = btoa("other:basic-token");
		const request = new Request("https://worker.example/push", {
			method: "POST",
			headers: { Authorization: `Basic ${credentials}` },
		});

		expect(deviceTokenFromRequest(request)).toBeNull();
	});
});

describe("sourceFromRequest", () => {
	it("reads the server label Trawl put on the webhook", () => {
		const request = new Request("https://worker.example/push", {
			method: "POST",
			headers: { "X-Trawl-Source": "Radarr 4K" },
		});

		expect(sourceFromRequest(request)).toBe("Radarr 4K");
	});

	// Prowlarr's webhook UI has no custom-header field, so its pushes arrive without
	// one and fall back to the payload's own instanceName.
	it("is absent when the webhook cannot send custom headers", () => {
		const request = new Request("https://worker.example/push", { method: "POST" });

		expect(sourceFromRequest(request)).toBeUndefined();
	});
});

describe("parseNotification", () => {
	it("formats Prowlarr health issue payloads as system health alerts", () => {
		const result = parseNotification({
			eventType: "Health",
			level: "Warning",
			message: "Indexer unavailable",
		});

		expect(result.title).toBe("Health Alert");
		expect(result.body).toBe("Warning: Indexer unavailable");
		expect(result.style).toBe("error");
	});

	it("names the instance that raised a health alert", () => {
		const result = parseNotification({
			eventType: "Health",
			level: "Error",
			message: "Download clients unavailable",
			instanceName: "Sonarr",
		});

		expect(result.title).toBe("Sonarr Health Alert");
		expect(result.body).toBe("Error: Download clients unavailable");
		expect(result.data.source).toBe("Sonarr");
	});

	it("carries Radarr titles in data so the app can enrich the banner", () => {
		const result = parseNotification({
			eventType: "Grab",
			movie: { id: 12, title: "Dune: Part Two", tmdbId: 693134 },
			release: { releaseTitle: "Dune.Part.Two.2024.2160p" },
		});

		expect(result.title).toBe("Dune: Part Two");
		expect(result.body).toBe("Grabbed: Dune.Part.Two.2024.2160p");
		expect(result.data.movieTitle).toBe("Dune: Part Two");
		expect(result.data.releaseTitle).toBe("Dune.Part.Two.2024.2160p");
		expect(result.data.deepLink).toBe("trawl://downloads");
		expect(result.collapseId).toBe("radarr-movie-12");
	});

	it("carries Sonarr episode info in data", () => {
		const result = parseNotification({
			eventType: "Download",
			series: { id: 7, title: "Severance" },
			episodes: [{ seasonNumber: 2, episodeNumber: 1, title: "Hello, Ms. Cobel" }],
		});

		expect(result.title).toBe("Severance");
		expect(result.body).toBe("Download Complete S2E1");
		expect(result.data.episodeTitle).toBe("Hello, Ms. Cobel");
		expect(result.collapseId).toBe("sonarr-series-7");
	});
});

// Two "Download Complete" banners for the same film, one from the HD server and one
// from the 4K one, were indistinguishable: nothing in either named the server.
describe("parseNotification — which server sent it", () => {
	const download = {
		eventType: "Download",
		movie: { id: 12, title: "The Sheep Detectives", tmdbId: 693134 },
	};

	it("names the server in the body of a media event", () => {
		const result = parseNotification(download, "Radarr 4K");

		expect(result.title).toBe("The Sheep Detectives");
		expect(result.body).toBe("Download Complete · Radarr 4K");
		expect(result.data.source).toBe("Radarr 4K");
	});

	it("says nothing extra when no server label is available", () => {
		const result = parseNotification(download);

		expect(result.body).toBe("Download Complete");
		expect(result.data.source).toBeUndefined();
	});

	// instanceName defaults to "Radarr" on every install, so the label Trawl sends is
	// the only one that separates an HD server from a 4K one.
	it("prefers Trawl's label over the Arr's own instanceName", () => {
		const result = parseNotification({ ...download, instanceName: "Radarr" }, "Radarr 4K");

		expect(result.body).toBe("Download Complete · Radarr 4K");
	});

	it("falls back to instanceName when the webhook cannot send a header", () => {
		const result = parseNotification({ ...download, instanceName: "Radarr" });

		expect(result.body).toBe("Download Complete · Radarr");
	});

	// Both servers number their libraries independently, so movie 12 exists on each.
	// An unscoped collapse id made the second push replace the first, silently.
	it("keeps two servers' pushes for the same movie id apart", () => {
		const hd = parseNotification(download, "Radarr");
		const uhd = parseNotification(download, "Radarr 4K");

		expect(hd.collapseId).toBe("radarr-movie-12@radarr");
		expect(uhd.collapseId).toBe("radarr-movie-12@radarr-4k");
		expect(hd.collapseId).not.toBe(uhd.collapseId);
	});

	it("scopes Sonarr series pushes the same way", () => {
		const result = parseNotification(
			{ eventType: "Download", series: { id: 7, title: "Severance" }, episodes: [] },
			"Sonarr 4K"
		);

		expect(result.collapseId).toBe("sonarr-series-7@sonarr-4k");
	});
});

// One broken indexer reported six times over two hours, and reported again by every
// Arr that syncs from Prowlarr, is one fault — not nine notifications.
describe("parseNotification — health alert deduplication", () => {
	const knaben = {
		eventType: "Health",
		level: "Warning",
		type: "IndexerStatusCheck",
		message: "Indexers unavailable due to failures: Knaben",
	};

	it("gives every report of one failing check the same collapse id", () => {
		const prowlarr = parseNotification(knaben, "Prowlarr");
		const radarr = parseNotification(
			{ ...knaben, message: "Indexers unavailable due to failures: Knaben (Prowlarr)" },
			"Radarr"
		);
		const sonarr = parseNotification({ ...knaben }, "Sonarr");

		expect(prowlarr.collapseId).toBe("health-indexerstatuscheck");
		expect(radarr.collapseId).toBe(prowlarr.collapseId);
		expect(sonarr.collapseId).toBe(prowlarr.collapseId);
	});

	it("still names the server that reported it", () => {
		expect(parseNotification(knaben, "Prowlarr").title).toBe("Prowlarr Health Alert");
	});

	it("does not merge unrelated checks", () => {
		const other = parseNotification(
			{ ...knaben, type: "DownloadClientStatusCheck", message: "Download clients unavailable" },
			"Sonarr"
		);

		expect(other.collapseId).not.toBe(parseNotification(knaben, "Sonarr").collapseId);
	});

	// So the lock screen stops showing a warning that is no longer true.
	it("lets the all-clear replace the alert it answers", () => {
		const restored = parseNotification(
			{ eventType: "HealthRestored", type: "IndexerStatusCheck", message: "Indexers are available again" },
			"Prowlarr"
		);

		expect(restored.collapseId).toBe(parseNotification(knaben, "Prowlarr").collapseId);
		expect(restored.interruptionLevel).toBe("passive");
	});

	// Older Arr builds, and anything posting a hand-rolled payload, may omit `type`.
	it("falls back to the message when the check type is missing", () => {
		const a = parseNotification({ eventType: "Health", message: "Indexers unavailable" });
		const b = parseNotification({ eventType: "Health", message: "Indexers unavailable" });
		const c = parseNotification({ eventType: "Health", message: "Download clients unavailable" });

		expect(a.collapseId).toBeDefined();
		expect(b.collapseId).toBe(a.collapseId);
		expect(c.collapseId).not.toBe(a.collapseId);
	});

	it("collapses nothing when there is neither a type nor a message", () => {
		expect(parseNotification({ eventType: "Health" }).collapseId).toBeUndefined();
	});
});

describe("parseNotification — Seerr", () => {
	// The app registers Seerr's webhook itself and enables every notification type,
	// so all twelve of these can arrive. None of them were handled before.
	const seerrBase = {
		subject: "Dune: Part Two (2024)",
		message: "Paul Atreides unites with Chani and the Fremen...",
		requestedBy: "james",
		requestId: "42",
		tmdbId: "693134",
		mediaType: "movie",
	};

	it.each([
		["MEDIA_PENDING", "New request awaiting approval · james", "passive"],
		["MEDIA_APPROVED", "Request approved · james", "active"],
		["MEDIA_AUTO_APPROVED", "Request automatically approved · james", "active"],
		["MEDIA_AUTO_REQUESTED", "Automatically requested · james", "passive"],
		["MEDIA_AVAILABLE", "Now available to watch · james", "active"],
		["MEDIA_DECLINED", "Request declined · james", "active"],
		["MEDIA_FAILED", "Request failed · james", "time-sensitive"],
	])("renders %s with the media title as the headline", (eventType, body, level) => {
		const result = parseNotification({ ...seerrBase, eventType });

		expect(result.title).toBe("Dune: Part Two (2024)");
		expect(result.body).toBe(body);
		expect(result.interruptionLevel).toBe(level);
		expect(result.data.deepLink).toBe("trawl://seerr-requests");
		expect(result.collapseId).toBe("seerr-request-42");
		expect(result.threadId).toBe("seerr");
	});

	it("never uses the plot synopsis as the body", () => {
		const result = parseNotification({ ...seerrBase, eventType: "MEDIA_AVAILABLE" });
		expect(result.body).not.toContain("Paul Atreides");
	});

	it.each(["MEDIA_DECLINED", "MEDIA_FAILED"])("marks %s as an error", (eventType) => {
		const result = parseNotification({ ...seerrBase, eventType });
		expect(result.style).toBe("error");
		expect(result.data.style).toBe("error");
	});

	it.each([
		["ISSUE_CREATED", "Video issue reported · james: Audio is out of sync"],
		["ISSUE_COMMENT", "james commented: Audio is out of sync"],
		["ISSUE_RESOLVED", "Issue resolved · james"],
		["ISSUE_REOPENED", "Issue reopened · james"],
	])("routes %s to the issue deep link", (eventType, body) => {
		const result = parseNotification({
			...seerrBase,
			eventType,
			issueId: "9",
			issueType: "Video",
			comment: "Audio is out of sync",
		});

		expect(result.body).toBe(body);
		expect(result.data.deepLink).toBe("trawl://seerr-issue");
		expect(result.collapseId).toBe("seerr-issue-9");
	});

	// This one line was the whole basis of "Seerr support is broken": the worker only
	// matched Sonarr/Radarr's "Test", so pressing Test in Seerr pushed a banner titled
	// with the raw enum.
	it("handles TEST_NOTIFICATION, not just the Arr spelling of Test", () => {
		const result = parseNotification({ eventType: "TEST_NOTIFICATION", subject: "Test Notification" });

		expect(result.title).toBe("Trawl Test");
		expect(result.body).toContain("Seerr is connected");
	});

	it("humanizes an unknown Seerr-shaped event rather than showing the raw enum", () => {
		const result = parseNotification({ ...seerrBase, eventType: "MEDIA_SOMETHING_NEW" });
		expect(result.title).not.toBe("MEDIA_SOMETHING_NEW");
	});

	it("treats unfilled template placeholders as absent", () => {
		const result = parseNotification({
			eventType: "MEDIA_APPROVED",
			subject: "Arrival (2016)",
			requestedBy: "{{requestedBy_username}}",
			requestId: "",
			issueId: "{{issue_id}}",
		});

		expect(result.body).toBe("Request approved");
		expect(result.data.requestedBy).toBeUndefined();
		expect(result.collapseId).toBeUndefined();
	});
});
