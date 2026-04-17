import "./graphql/server";
import "./uploads";

import { router } from "./router";

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 4000);
  await router.listen({ port, host: "0.0.0.0" });
}
