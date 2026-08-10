import assert from "node:assert/strict";
import test from "node:test";

import { FakeElement } from "./helpers/fake-dom.mjs";
import { withPatchedGlobals } from "./helpers/test-utils.mjs";

test("METAR renders Gateway failure details and recovers the existing station row", async () => {
  const head = new FakeElement("head");
  let registration;
  let requestCount = 0;

  await withPatchedGlobals({
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      getElementById: () => null,
      head
    },
    async fetch() {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: false,
          status: 502,
          async json() {
            return {
              ok: false,
              data: null,
              error: { code: "upstream_error", message: "Gateway offline" }
            };
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            data: {
              stations: {
                KDFW: {
                  icaoId: "KDFW",
                  rawOb: "KDFW 191753Z 18012KT 10SM CLR 31/22 A2992 RMK AO2"
                }
              }
            },
            error: null
          };
        }
      };
    },
    window: {
      DASH_CONFIG: { apiBase: "/api" },
      DASH: {
        registerWidget(type, implementation) {
          registration = { type, implementation };
        }
      }
    }
  }, async () => {
    await import(`../dashboard/widgets/metar.js?test=${Date.now()}`);
    const root = new FakeElement("section");
    const instance = registration.implementation.mount(root, {
      props: { stations: ["KDFW"] }
    });
    const originalRow = instance.rows.KDFW;

    assert.equal(originalRow.tile.classList.contains("ui-tile"), true);
    const [stationField, ...detailFields] = originalRow.tile.children;
    assert.equal(stationField.classList.contains("label"), true);
    assert.equal(stationField.classList.contains("metar-station"), true);
    assert.equal(
      originalRow.tile.children.every(
        (field) => field.classList.contains("metar-field")
      ),
      true
    );
    assert.equal(
      detailFields.every((field) => field.classList.contains("label-info")),
      true
    );

    await registration.implementation.update(instance);
    assert.equal(originalRow.station.textContent, "KDFW");
    assert.equal(originalRow.timestampSpan.textContent, "ERR");
    assert.equal(originalRow.remarksSpan.textContent, "Gateway unavailable: Gateway offline");
    assert.equal(originalRow.tile.classList.contains("error"), true);

    await registration.implementation.update(instance);
    assert.equal(instance.rows.KDFW, originalRow);
    assert.equal(originalRow.station.textContent, "KDFW");
    assert.equal(originalRow.timestampSpan.textContent, "191753Z");
    assert.equal(originalRow.windSpan.textContent, "180@12KT");
    assert.equal(originalRow.remarksSpan.textContent, "AO2");
    assert.equal(originalRow.tile.classList.contains("error"), false);
  });
});
