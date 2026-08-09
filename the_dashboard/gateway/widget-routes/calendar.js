import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Router } from "express";
import { CONFIG } from "../platform/config.js";
import { sendError, sendOk } from "../platform/responses.js";
import {
  CalendarDataError,
  parseCalendarOccurrences
} from "./calendar-data.js";

const MAX_FEED_URL_LENGTH = 2048;
const MAX_RANGE_DAYS = 400;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 4;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_EXPANDED_OCCURRENCES = 5000;
const MAX_TIMEZONE_LENGTH = 100;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_FEED_PROTOCOLS = new Set(["http:", "https:"]);
const REQUEST_HEADERS = Object.freeze({
  Accept: "text/calendar, text/plain;q=0.9, */*;q=0.1",
  "User-Agent": "homelab-dashboard-calendar/1.0"
});
const IPV4_BLOCKED_RANGES = Object.freeze([
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
]);
const IPV6_BLOCKED_RANGES = Object.freeze([
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16]
]);

export class CalendarGatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "CalendarGatewayError";
    this.status = status;
    this.code = code;
  }
}

function ipv4Number(address) {
  const octets = String(address).split(".").map(Number);
  if (
    octets.length !== 4
    || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return octets.reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

function ipv4InRange(address, base, prefixLength) {
  const value = ipv4Number(address);
  const baseValue = ipv4Number(base);
  if (value === null || baseValue === null) return false;
  const mask = prefixLength === 0
    ? 0
    : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function ipv6Segments(address) {
  let normalized = String(address).toLowerCase().split("%")[0];
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = ipv4Number(normalized.slice(lastColon + 1));
    if (lastColon < 0 || ipv4 === null) return null;
    normalized = `${normalized.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;

  const segments = [...left, ...Array(missing).fill("0"), ...right];
  if (segments.some((segment) => !/^[0-9a-f]{1,4}$/.test(segment))) return null;
  return segments.map((segment) => Number.parseInt(segment, 16));
}

function ipv6Number(address) {
  const segments = ipv6Segments(address);
  return segments?.reduce(
    (value, segment) => (value << 16n) | BigInt(segment),
    0n
  ) ?? null;
}

function ipv6InRange(address, base, prefixLength) {
  const value = ipv6Number(address);
  const baseValue = ipv6Number(base);
  if (value === null || baseValue === null) return false;
  const shift = BigInt(128 - prefixLength);
  return (value >> shift) === (baseValue >> shift);
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    return !IPV4_BLOCKED_RANGES.some(([base, prefix]) => (
      ipv4InRange(address, base, prefix)
    ));
  }
  if (family !== 6) return false;

  const value = ipv6Number(address);
  if (value === null) return false;

  const mappedIpv4Prefix = 0xffffn;
  if ((value >> 32n) === mappedIpv4Prefix) {
    const mapped = Number(value & 0xffffffffn);
    const mappedAddress = [24, 16, 8, 0]
      .map((shift) => (mapped >>> shift) & 0xff)
      .join(".");
    return isPublicAddress(mappedAddress);
  }

  const isGlobalUnicast = (value >> 125n) === 1n;
  return isGlobalUnicast && !IPV6_BLOCKED_RANGES.some(([base, prefix]) => (
    ipv6InRange(address, base, prefix)
  ));
}

function normalizeHostname(hostname) {
  return String(hostname).replace(/^\[|\]$/g, "");
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function resolvePublicDestination(url, resolveHost, signal) {
  const hostname = normalizeHostname(url.hostname);
  let addresses;
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(resolveHost(hostname, { all: true, verbatim: true }), signal);
  } catch (error) {
    if (signal.aborted || error?.name === "AbortError") throw error;
    throw new CalendarGatewayError(
      502,
      "calendar_upstream_unreachable",
      "Calendar feed is unreachable."
    );
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new CalendarGatewayError(
      502,
      "calendar_upstream_unreachable",
      "Calendar feed is unreachable."
    );
  }
  if (addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new CalendarGatewayError(
      400,
      "calendar_feed_not_public",
      "Calendar feed must resolve only to public addresses."
    );
  }

  return addresses[0];
}

function defaultRequestOnce(url, { address, family, signal }) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: "GET",
      headers: REQUEST_HEADERS,
      signal,
      lookup(_hostname, options, callback) {
        if (options?.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      }
    }, (response) => {
      resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: response
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function readBoundedBody(body, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      body.destroy?.();
      throw new CalendarGatewayError(
        502,
        "calendar_feed_too_large",
        "Calendar feed exceeds the download limit."
      );
    }
    chunks.push(buffer);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function createCalendarFeedClient({
  timeoutMs,
  maxRedirects,
  maxBytes,
  resolveHost = lookup,
  requestOnce = defaultRequestOnce,
  signalForTimeout = AbortSignal.timeout
}) {
  async function fetchCalendar(initialUrl) {
    const signal = signalForTimeout(timeoutMs);
    let url = initialUrl;
    let redirectCount = 0;

    try {
      while (true) {
        const destination = await resolvePublicDestination(url, resolveHost, signal);
        const response = await requestOnce(url, { ...destination, signal });

        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirectCount >= maxRedirects) {
            throw new CalendarGatewayError(
              502,
              "calendar_redirect_limit",
              "Calendar feed exceeded the redirect limit."
            );
          }
          const location = firstHeaderValue(response.headers?.location);
          if (!location) {
            throw new CalendarGatewayError(
              502,
              "calendar_upstream_error",
              "Calendar feed returned an invalid redirect."
            );
          }
          response.body.destroy?.();
          url = validateFeedUrl(new URL(location, url).toString());
          redirectCount += 1;
          continue;
        }

        if (response.status < 200 || response.status >= 300) {
          throw new CalendarGatewayError(
            502,
            "calendar_upstream_error",
            "Calendar feed returned an unsuccessful response."
          );
        }

        const contentLength = Number(firstHeaderValue(response.headers?.["content-length"]));
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          response.body.destroy?.();
          throw new CalendarGatewayError(
            502,
            "calendar_feed_too_large",
            "Calendar feed exceeds the download limit."
          );
        }
        return await readBoundedBody(response.body, maxBytes);
      }
    } catch (error) {
      if (error instanceof CalendarGatewayError) throw error;
      if (signal.aborted || error?.name === "AbortError") {
        throw new CalendarGatewayError(
          504,
          "calendar_upstream_timeout",
          "Calendar feed request timed out."
        );
      }
      if (error instanceof TypeError && /encoded data/i.test(error.message)) {
        throw new CalendarGatewayError(
          502,
          "malformed_calendar",
          "Calendar data is malformed."
        );
      }
      throw new CalendarGatewayError(
        502,
        "calendar_upstream_unreachable",
        "Calendar feed is unreachable."
      );
    }
  }

  return Object.freeze({ fetchCalendar });
}

function invalidRequest(code, message) {
  throw new CalendarGatewayError(400, code, message);
}

function stringQueryValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function validateFeedUrl(value) {
  const raw = stringQueryValue(value);
  if (!raw || raw.length > MAX_FEED_URL_LENGTH) {
    invalidRequest("invalid_calendar_feed_url", "Calendar feed URL is invalid.");
  }

  const normalized = raw.replace(/^webcal:\/\//i, "https://");
  let url;
  try {
    url = new URL(normalized);
  } catch {
    invalidRequest("invalid_calendar_feed_url", "Calendar feed URL is invalid.");
  }
  if (!ALLOWED_FEED_PROTOCOLS.has(url.protocol) || url.username || url.password) {
    invalidRequest("invalid_calendar_feed_url", "Calendar feed URL is invalid.");
  }
  return url;
}

function validateTimeZone(value) {
  const timeZone = stringQueryValue(value);
  if (!timeZone || timeZone.length > MAX_TIMEZONE_LENGTH) {
    invalidRequest("invalid_calendar_timezone", "Calendar timezone is invalid.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    invalidRequest("invalid_calendar_timezone", "Calendar timezone is invalid.");
  }
  return timeZone;
}

function validateRange(fromValue, toValue) {
  const fromSource = stringQueryValue(fromValue);
  const toSource = stringQueryValue(toValue);
  const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  if (!isoPattern.test(fromSource) || !isoPattern.test(toSource)) {
    invalidRequest("invalid_calendar_range", "Calendar date range is invalid.");
  }

  const rangeStart = new Date(fromSource);
  const rangeEnd = new Date(toSource);
  const rangeMilliseconds = rangeEnd - rangeStart;
  if (
    !Number.isFinite(rangeMilliseconds)
    || rangeMilliseconds <= 0
    || rangeMilliseconds > MAX_RANGE_DAYS * MILLISECONDS_PER_DAY
  ) {
    invalidRequest("invalid_calendar_range", "Calendar date range is invalid.");
  }
  return { rangeStart, rangeEnd };
}

export function createCalendarHandler({
  feedClient = createCalendarFeedClient({
    timeoutMs: CONFIG.upstreamTimeoutMs,
    maxRedirects: MAX_REDIRECTS,
    maxBytes: MAX_FEED_BYTES
  }),
  parseOccurrences = parseCalendarOccurrences
} = {}) {
  return async function calendarHandler(req, res) {
    try {
      const feedUrl = validateFeedUrl(req.query?.feedUrl);
      const timeZone = validateTimeZone(req.query?.timeZone);
      const { rangeStart, rangeEnd } = validateRange(req.query?.from, req.query?.to);
      const source = await feedClient.fetchCalendar(feedUrl);
      const events = await parseOccurrences(source, {
        rangeStart,
        rangeEnd,
        timeZone,
        maxOccurrences: MAX_EXPANDED_OCCURRENCES
      });
      return sendOk(res, { events });
    } catch (error) {
      if (error instanceof CalendarGatewayError) {
        return sendError(res, error.status, error.code, error.message);
      }
      if (error instanceof CalendarDataError) {
        return sendError(res, 502, error.code, error.message);
      }
      return sendError(
        res,
        502,
        "calendar_processing_failed",
        "Calendar feed could not be processed."
      );
    }
  };
}

const router = Router();
router.get("/calendar/events", createCalendarHandler());

export default router;
