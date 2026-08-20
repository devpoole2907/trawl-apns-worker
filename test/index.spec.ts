import { describe, expect, it } from "vitest";
import { deviceTokenFromRequest, parseNotification } from "../src/index";

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

describe("parseNotification", () => {
	it("formats Prowlarr health issue payloads as system health alerts", () => {
		const result = parseNotification({
			eventType: "HealthIssue",
			level: "Warning",
			message: "Indexer unavailable",
		});

		expect(result.title).toBe("Health Alert");
		expect(result.body).toBe("Warning: Indexer unavailable");
		expect(result.style).toBe("error");
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
