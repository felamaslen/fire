import * as countrySchema from "./schema/country";
import * as currencySchema from "./schema/currency";
import * as investmentsSchema from "./schema/investments";
import * as netWorthSchema from "./schema/net-worth";
import * as planningSchema from "./schema/planning";
import * as settingsSchema from "./schema/settings";

export const schema = {
  ...countrySchema,
  ...currencySchema,
  ...investmentsSchema,
  ...netWorthSchema,
  ...planningSchema,
  ...settingsSchema,
};
export type Schema = typeof schema;
