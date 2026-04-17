import * as countrySchema from "./schema/country";
import * as currencySchema from "./schema/currency";
import * as netWorthSchema from "./schema/net-worth";
import * as planningSchema from "./schema/planning";

export const schema = {
  ...countrySchema,
  ...currencySchema,
  ...netWorthSchema,
  ...planningSchema,
};
export type Schema = typeof schema;
