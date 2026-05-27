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
		expect(parseNotification({
			eventType: "HealthIssue",
			level: "Warning",
			message: "Indexer unavailable",
		})).toEqual({
			title: "Health Alert",
			body: "Warning: Indexer unavailable",
		});
	});
});
