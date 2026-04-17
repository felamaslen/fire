import "@/index";

import { router } from "@/router";

it("GET /files/:key returns 404 for unknown keys", async () => {
  const res = await router.inject({
    method: "GET",
    url: "/files/does-not-exist",
  });
  expect(res.statusCode).toBe(404);
});

it("GET /files/:key rejects path traversal with a 404", async () => {
  const res = await router.inject({
    method: "GET",
    url: "/files/..%2Fpackage.json",
  });
  expect(res.statusCode).toBe(404);
});
