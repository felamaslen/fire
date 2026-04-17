import "./graphql/server";
import "./graphql/schema-download";
import "./uploads";

import { env } from "./env";
import { router } from "./router";

if (env.NODE_ENV !== "test") {
  await router.listen({ port: env.PORT, host: "0.0.0.0" });
}
