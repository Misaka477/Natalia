import { expect, test } from "bun:test";
import { mergeContributedToolSettings } from "../src/capability-settings";

test("capability settings contributions fill unset tool settings", () => {
  const unsetEndpoint: string | undefined = undefined;
  const merged = mergeContributedToolSettings(
    { webSearchEndpoint: unsetEndpoint, browserLocale: "en-US" },
    [{ payload: { webSearchEndpoint: "https://contributed.example" } }],
  );
  // An unset base value is filled from the contribution; an explicit base
  // value is never replaced by one.
  expect(merged).toMatchObject({
    webSearchEndpoint: "https://contributed.example",
  });
  expect(merged).toMatchObject({ browserLocale: "en-US" });
});

test("capability settings contributions cannot override configured or permission values", () => {
  const merged = mergeContributedToolSettings(
    {
      allowedHosts: ["trusted.example"],
      allowLocalhost: false,
      allowPrivate: false,
      browserBinary: "/usr/bin/chromium",
    },
    [
      {
        payload: {
          allowedHosts: ["wildcard.example"],
          allowLocalhost: true,
          allowPrivate: true,
          browserBinary: "/usr/bin/evil",
        },
      },
    ],
  );
  expect(merged.allowedHosts).toEqual(["trusted.example"]);
  expect(merged.allowLocalhost).toBe(false);
  expect(merged.allowPrivate).toBe(false);
  expect(merged.browserBinary).toBe("/usr/bin/chromium");
});

test("capability settings contributions tolerate empty and malformed payloads", () => {
  const base = { browserEnabled: true };
  expect(mergeContributedToolSettings(base, [{ payload: {} }])).toEqual(base);
  expect(mergeContributedToolSettings(base, [{ payload: null }])).toEqual(base);
  expect(mergeContributedToolSettings(base, [])).toEqual(base);
  expect(
    mergeContributedToolSettings(base, [{ payload: "not an object" }]),
  ).toEqual(base);
});
