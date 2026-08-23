import assert from "node:assert/strict";
import test from "node:test";

import { FakeDocument, FakeElement, findAll } from "./helpers/fake-dom.mjs";
import {
  createDeferred,
  createSuccessResponse,
  withPatchedGlobals
} from "./helpers/test-utils.mjs";

const SERVICE_URL = "https://service.example.test/health";
let widgetImportNumber = 0;

async function withStatusWidget(fetchImplementation, run) {
  let registration;
  const window = {
    DASH_CONFIG: { apiBase: "/api" },
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    }
  };

  await withPatchedGlobals({
    CSS: { supports: () => true },
    document: new FakeDocument({ supportsPopover: true }),
    fetch: fetchImplementation,
    window
  }, async () => {
    widgetImportNumber += 1;
    await import(`../dashboard/widgets/status.js?test=${widgetImportNumber}`);
    await run({ registration });
  });
}

function statusResponse({
  detail = "HTTP 200 • 12ms",
  href = SERVICE_URL,
  indicator = "passing"
} = {}) {
  return createSuccessResponse({
    results: [{
      indicator,
      detail,
      href
    }]
  });
}

test("status lets an in-flight batch finish before starting another", async () => {
  const response = createDeferred();
  let requestCount = 0;

  await withStatusWidget(
    async () => {
      requestCount += 1;
      return response.promise;
    },
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, {
        props: {
          checks: [{
            name: "Example service",
            provider: { type: "http", url: SERVICE_URL }
          }]
        }
      });
      const [tile] = state.tiles;

      assert.equal(tile.popup.classList.contains("popup--floating"), true);
      assert.equal(tile.popup.getAttribute("popover"), "manual");

      const firstUpdate = registration.implementation.update(state);
      const overlappingUpdate = registration.implementation.update(state);
      assert.equal(requestCount, 1);

      response.resolve(statusResponse());
      await Promise.all([firstUpdate, overlappingUpdate]);

      assert.equal(tile.dot.classList.contains("dot--ok"), true);
      assert.equal(tile.popup.textContent, "HTTP 200 • 12ms");
      assert.equal(state.updating, false);
    }
  );
});

test("status rejects checks without the required common fields", async () => {
  const validProvider = { type: "http", url: SERVICE_URL };
  let submittedBody;

  await withStatusWidget(
    async (_url, options) => {
      submittedBody = JSON.parse(options.body);
      return statusResponse();
    },
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, {
        props: {
          checks: [
            { provider: validProvider },
            { name: " ", provider: validProvider },
            { name: "Missing provider" },
            { name: "Wrong icon", icon: 42, provider: validProvider },
            { name: "Valid check", provider: validProvider }
          ]
        }
      });

      await registration.implementation.update(state);

      const dots = findAll(root, (element) => element.classList.contains("dot"));
      assert.equal(dots.length, 1);
      assert.deepEqual(submittedBody, { providers: [validProvider] });
      assert.equal(
        state.warning.textContent,
        "Some status checks have invalid configuration."
      );
    }
  );
});

test("status renders ordered duplicate checks and applies normalized results by index", async () => {
  const duplicateProvider = {
    type: "github-actions",
    repository: "BRL-CAD/brlcad",
    workflow: "push.yml"
  };
  const checks = [
    { name: "BRL-CAD CI", provider: duplicateProvider },
    { name: "Home Assistant", provider: { type: "http", url: SERVICE_URL } },
    { name: "BRL-CAD CI", provider: duplicateProvider }
  ];
  const results = [
    { indicator: "passing", detail: "Workflow passed.", href: "https://github.com/run/1" },
    { indicator: "attention", detail: "HTTP 503 • 12ms", href: null },
    { indicator: "other", detail: "Workflow running.", href: "https://github.com/run/2" }
  ];
  let submittedBody;

  await withStatusWidget(
    async (_url, options) => {
      submittedBody = JSON.parse(options.body);
      return createSuccessResponse({ results });
    },
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, { props: { checks } });

      await registration.implementation.update(state);

      assert.deepEqual(submittedBody, {
        providers: [duplicateProvider, checks[1].provider, duplicateProvider]
      });
      const dots = findAll(root, (element) => element.classList.contains("dot"));
      assert.equal(dots.length, 3);
      assert.equal(dots[0].classList.contains("dot--ok"), true);
      assert.equal(dots[1].classList.contains("dot--err"), true);
      assert.equal(dots[2].classList.contains("dot--warn"), true);
      assert.equal(dots[0].getAttribute("aria-label"), "BRL-CAD CI: passing. Workflow passed.");
      assert.equal(dots[1].getAttribute("aria-label"), "Home Assistant: attention. HTTP 503 • 12ms");
      assert.equal(dots[2].getAttribute("aria-label"), "BRL-CAD CI: other. Workflow running.");

      assert.equal(state.tiles[0].link.getAttribute("href"), "https://github.com/run/1");
      assert.equal(state.tiles[0].link.classList.contains("clickable"), true);
      assert.equal(state.tiles[1].link.getAttribute("href"), null);
      assert.equal(state.tiles[1].link.classList.contains("clickable"), false);
      assert.equal(state.tiles[2].link.getAttribute("href"), "https://github.com/run/2");
    }
  );
});

test("status renders the representative provider matrix with consistent tile surfaces", async () => {
  const scenarios = [
    {
      check: {
        name: "Router",
        icon: "🛜",
        provider: { type: "http", url: "192.168.1.1" }
      },
      result: {
        indicator: "passing",
        detail: "HTTP 200 • 12ms",
        href: "http://192.168.1.1/"
      },
      iconText: "🛜"
    },
    {
      check: {
        name: "Pi-hole",
        icon: "🛡️",
        provider: { type: "http", url: "http://localhost/admin/" }
      },
      result: {
        indicator: "passing",
        detail: "HTTP 200 • 8ms",
        href: "http://localhost/admin/"
      },
      iconText: "🛡️"
    },
    {
      check: {
        name: "Syncthing",
        icon: "🗘",
        provider: { type: "http", url: "http://localhost:18086" }
      },
      result: {
        indicator: "passing",
        detail: "HTTP 200 • 5ms",
        href: "http://localhost:18086/"
      },
      iconText: "🗘"
    },
    {
      check: {
        name: "Home Assistant",
        icon: "🏠",
        provider: { type: "http", url: "http://localhost:8123" }
      },
      result: {
        indicator: "passing",
        detail: "HTTP 200 • 7ms",
        href: "http://localhost:8123/"
      },
      iconText: "🏠"
    },
    {
      check: {
        name: "BRL-CAD CI",
        icon: "/icons/github.svg",
        provider: {
          type: "github-actions",
          repository: "BRL-CAD/brlcad",
          workflow: "push.yml"
        }
      },
      result: {
        indicator: "other",
        detail: "Workflow in progress.",
        href: "https://github.com/BRL-CAD/brlcad/actions/runs/42"
      },
      imageIcon: "/icons/github.svg"
    },
    {
      check: {
        name: "Expected broken",
        provider: { type: "http", url: "https://offline.example.test" }
      },
      result: {
        indicator: "attention",
        detail: "No response from target.",
        href: "https://offline.example.test/"
      },
      iconText: "-"
    },
    {
      check: {
        name: "No destination",
        provider: { type: "unknown" }
      },
      result: {
        indicator: "attention",
        detail: "Unknown status provider \"unknown\".",
        href: null
      },
      iconText: "-"
    }
  ];
  const checks = scenarios.map(({ check }) => check);
  let submittedBody;

  await withStatusWidget(
    async (_url, options) => {
      submittedBody = JSON.parse(options.body);
      return createSuccessResponse({
        results: scenarios.map(({ result }) => result)
      });
    },
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, { props: { checks } });

      for (const tile of state.tiles) {
        assert.equal(tile.link.classList.contains("ui-tile"), true);
        assert.equal(tile.link.classList.contains("clickable"), false);
      }

      await registration.implementation.update(state);

      assert.deepEqual(submittedBody, {
        providers: checks.map(({ provider }) => provider)
      });
      for (const [index, scenario] of scenarios.entries()) {
        const tile = state.tiles[index];
        const icons = findAll(
          tile.link,
          (element) => element.classList.contains("icon")
        );
        const expectedHref = scenario.result.href;

        assert.equal(icons.length, 1, scenario.check.name);
        const [icon] = icons;
        assert.equal(tile.link.classList.contains("ui-tile"), true, scenario.check.name);
        assert.equal(
          tile.link.classList.contains("clickable"),
          Boolean(expectedHref),
          scenario.check.name
        );
        assert.equal(tile.link.getAttribute("href"), expectedHref, scenario.check.name);
        assert.equal(
          tile.dot.getAttribute("aria-label"),
          `${scenario.check.name}: ${scenario.result.indicator}. ${scenario.result.detail}`
        );

        if (scenario.imageIcon) {
          assert.equal(icon.children[0].src, scenario.imageIcon);
          assert.equal(icon.children[0].alt, `${scenario.check.name} icon`);
        } else {
          assert.equal(icon.textContent, scenario.iconText);
        }
      }
    }
  );
});

test("status preserves the last successful results when a whole refresh fails", async () => {
  const responses = [
    () => statusResponse(),
    async () => { throw new Error("Gateway offline"); },
    () => statusResponse({ detail: "Workflow running.", href: null, indicator: "other" })
  ];

  await withStatusWidget(
    async () => responses.shift()(),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, {
        props: {
          checks: [{
            name: "Example service",
            provider: { type: "http", url: SERVICE_URL }
          }]
        }
      });
      const [tile] = state.tiles;

      await registration.implementation.update(state);
      await registration.implementation.update(state);

      assert.equal(tile.dot.classList.contains("dot--ok"), true);
      assert.equal(tile.popup.textContent, "HTTP 200 • 12ms");
      assert.equal(tile.link.getAttribute("href"), SERVICE_URL);
      assert.equal(
        state.warning.textContent,
        "Refresh failed; showing previous results."
      );

      await registration.implementation.update(state);

      assert.equal(tile.dot.classList.contains("dot--warn"), true);
      assert.equal(tile.popup.textContent, "Workflow running.");
      assert.equal(tile.link.classList.contains("ui-tile"), true);
      assert.equal(tile.link.classList.contains("clickable"), false);
      assert.equal(tile.link.getAttribute("href"), null);
      assert.equal(tile.link.getAttribute("target"), null);
      assert.equal(tile.link.getAttribute("rel"), null);
      assert.equal(state.warning.textContent, "");
    }
  );
});

test("status reports Gateway unavailability without replacing initial checking state", async () => {
  await withStatusWidget(
    async () => { throw new Error("Gateway offline"); },
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, {
        props: {
          checks: [{
            name: "Example service",
            provider: { type: "http", url: SERVICE_URL }
          }]
        }
      });
      const [tile] = state.tiles;

      await registration.implementation.update(state);

      assert.equal(tile.dot.classList.contains("dot--warn"), true);
      assert.equal(tile.popup.textContent, "Checking…");
      assert.equal(
        tile.dot.getAttribute("aria-label"),
        "Example service: other. Checking…"
      );
      assert.equal(state.warning.textContent, "Gateway unavailable.");
    }
  );
});

test("status applies valid per-check results independently", async () => {
  const responses = [
    [
      { indicator: "passing", detail: "First passed.", href: null },
      { indicator: "passing", detail: "Second passed.", href: null }
    ],
    [
      { indicator: "invalid", detail: "Do not apply.", href: null },
      { indicator: "attention", detail: "Second failed." }
    ]
  ];

  await withStatusWidget(
    async () => createSuccessResponse({ results: responses.shift() }),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, {
        props: {
          checks: [
            { name: "First", provider: { type: "http", url: SERVICE_URL } },
            { name: "Second", provider: { type: "http", url: SERVICE_URL } }
          ]
        }
      });

      await registration.implementation.update(state);
      await registration.implementation.update(state);

      assert.equal(state.tiles[0].dot.classList.contains("dot--ok"), true);
      assert.equal(state.tiles[0].popup.textContent, "First passed.");
      assert.equal(state.tiles[1].dot.classList.contains("dot--err"), true);
      assert.equal(state.tiles[1].popup.textContent, "Second failed.");
      assert.equal(
        state.warning.textContent,
        "Some status results were invalid."
      );
    }
  );
});
