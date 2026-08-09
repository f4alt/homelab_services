import assert from "node:assert/strict";
import test from "node:test";

import {
  CalendarGatewayError,
  createCalendarFeedClient,
  createCalendarHandler,
  isPublicAddress
} from "../gateway/widget-routes/calendar.js";
import { CalendarDataError } from "../gateway/widget-routes/calendar-data.js";
import { createGatewayResponse } from "./helpers/test-utils.mjs";

const VALID_QUERY = {
  feedUrl: "webcal://calendar.example.test/feed.ics",
  from: "2026-07-26T05:00:00.000Z",
  to: "2027-08-10T05:00:00.000Z",
  timeZone: "America/Chicago"
};

function bodyFrom(...chunks) {
  return chunks.map((chunk) => Buffer.from(chunk));
}

test("calendar handler validates its complete public query contract before fetching", async () => {
  let fetchCalls = 0;
  const handler = createCalendarHandler({
    feedClient: {
      async fetchCalendar() {
        fetchCalls += 1;
        return "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
      }
    },
    parseOccurrences: async () => []
  });
  const invalidQueries = [
    {},
    { ...VALID_QUERY, feedUrl: "ftp://calendar.example.test/feed.ics" },
    { ...VALID_QUERY, feedUrl: "https://user:secret@calendar.example.test/feed.ics" },
    { ...VALID_QUERY, feedUrl: "not a URL" },
    { ...VALID_QUERY, from: "yesterday" },
    { ...VALID_QUERY, from: "2026-99-99T00:00:00.000Z" },
    { ...VALID_QUERY, to: VALID_QUERY.from },
    { ...VALID_QUERY, to: "2028-08-10T05:00:00.000Z" },
    { ...VALID_QUERY, timeZone: "Not/A-Timezone" }
  ];

  for (const query of invalidQueries) {
    const response = createGatewayResponse();
    await handler({ query }, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.ok, false);
    assert.match(response.body.error.code, /^invalid_calendar_/);
  }
  assert.equal(fetchCalls, 0);
});

test("calendar handler normalizes webcal and returns events in the standard envelope", async () => {
  const requests = [];
  const parseCalls = [];
  const events = [{ id: "event" }];
  const handler = createCalendarHandler({
    feedClient: {
      async fetchCalendar(url) {
        requests.push(url.toString());
        return "calendar source";
      }
    },
    async parseOccurrences(source, options) {
      parseCalls.push({ source, options });
      return events;
    }
  });
  const response = createGatewayResponse();

  await handler({ query: VALID_QUERY }, response);

  assert.deepEqual(requests, ["https://calendar.example.test/feed.ics"]);
  assert.equal(parseCalls[0].source, "calendar source");
  assert.equal(parseCalls[0].options.timeZone, "America/Chicago");
  assert.equal(parseCalls[0].options.maxOccurrences, 5000);
  assert.deepEqual(response.body, {
    ok: true,
    data: { events },
    error: null
  });
});

test("calendar public-address policy rejects private, loopback, link-local, and reserved ranges", () => {
  const rejected = [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "ff02::1"
  ];

  rejected.forEach((address) => assert.equal(isPublicAddress(address), false, address));
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("calendar feed client pins a validated address and revalidates every redirect", async () => {
  const requests = [];
  const client = createCalendarFeedClient({
    timeoutMs: 1234,
    maxRedirects: 3,
    maxBytes: 1024,
    signalForTimeout: () => new AbortController().signal,
    resolveHost: async (hostname) => hostname === "calendar.example.test"
      ? [{ address: "8.8.8.8", family: 4 }]
      : [{ address: "10.0.0.2", family: 4 }],
    async requestOnce(url, options) {
      requests.push({ url: url.toString(), options });
      return {
        status: 302,
        headers: { location: "http://private.example.test/feed.ics" },
        body: bodyFrom()
      };
    }
  });

  await assert.rejects(
    client.fetchCalendar(new URL("https://calendar.example.test/feed.ics")),
    { code: "calendar_feed_not_public" }
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.address, "8.8.8.8");
});

test("calendar feed client enforces response, redirect, and byte limits without exposing content", async () => {
  const publicResolution = async () => [{ address: "8.8.8.8", family: 4 }];
  const oversized = createCalendarFeedClient({
    timeoutMs: 1000,
    maxRedirects: 2,
    maxBytes: 5,
    resolveHost: publicResolution,
    signalForTimeout: () => new AbortController().signal,
    requestOnce: async () => ({
      status: 200,
      headers: {},
      body: bodyFrom("secret", " calendar")
    })
  });
  await assert.rejects(
    oversized.fetchCalendar(new URL("https://calendar.example.test/feed.ics")),
    (error) => error.code === "calendar_feed_too_large"
      && !error.message.includes("secret")
  );

  const upstreamError = createCalendarFeedClient({
    timeoutMs: 1000,
    maxRedirects: 2,
    maxBytes: 1024,
    resolveHost: publicResolution,
    signalForTimeout: () => new AbortController().signal,
    requestOnce: async () => ({ status: 503, headers: {}, body: bodyFrom("secret") })
  });
  await assert.rejects(
    upstreamError.fetchCalendar(new URL("https://calendar.example.test/feed.ics")),
    { code: "calendar_upstream_error", status: 502 }
  );

  const redirects = createCalendarFeedClient({
    timeoutMs: 1000,
    maxRedirects: 1,
    maxBytes: 1024,
    resolveHost: publicResolution,
    signalForTimeout: () => new AbortController().signal,
    requestOnce: async () => ({
      status: 302,
      headers: { location: "https://calendar.example.test/again.ics" },
      body: bodyFrom()
    })
  });
  await assert.rejects(
    redirects.fetchCalendar(new URL("https://calendar.example.test/feed.ics")),
    { code: "calendar_redirect_limit" }
  );
});

test("calendar feed timeout covers DNS resolution as well as response streaming", async () => {
  const client = createCalendarFeedClient({
    timeoutMs: 5,
    maxRedirects: 1,
    maxBytes: 1024,
    resolveHost: async () => new Promise(() => {}),
    requestOnce: async () => assert.fail("request must not start before DNS resolves"),
    signalForTimeout: () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5);
      return controller.signal;
    }
  });

  await assert.rejects(
    client.fetchCalendar(new URL("https://calendar.example.test/feed.ics")),
    { code: "calendar_upstream_timeout", status: 504 }
  );
});

test("calendar handler translates parser and timeout failures to stable safe errors", async () => {
  const cases = [
    {
      feedClient: {
        async fetchCalendar() {
          throw new CalendarGatewayError(504, "calendar_upstream_timeout", "Timed out.");
        }
      },
      parseOccurrences: async () => [],
      expectedStatus: 504,
      expectedCode: "calendar_upstream_timeout"
    },
    {
      feedClient: { async fetchCalendar() { return "sensitive malformed feed"; } },
      parseOccurrences: async () => {
        throw new CalendarDataError("malformed_calendar", "Calendar data is malformed.");
      },
      expectedStatus: 502,
      expectedCode: "malformed_calendar"
    }
  ];

  for (const scenario of cases) {
    const handler = createCalendarHandler(scenario);
    const response = createGatewayResponse();
    await handler({ query: VALID_QUERY }, response);

    assert.equal(response.statusCode, scenario.expectedStatus);
    assert.equal(response.body.error.code, scenario.expectedCode);
    assert.equal(JSON.stringify(response.body).includes("sensitive"), false);
  }
});
