import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootTestApp, type TestApp } from "../helpers/app.js";

describe("server boot", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await bootTestApp();
  });

  afterAll(async () => {
    await app.stop();
  });

  it("serves the health endpoint", async () => {
    const res = await fetch(`${app.baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ok");
  });
});
