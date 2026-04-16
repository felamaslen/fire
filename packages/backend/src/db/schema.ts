import * as currencySchema from "./schema/currency";
import * as netWorthSchema from "./schema/net-worth";

export const schema = { ...currencySchema, ...netWorthSchema };
export type Schema = typeof schema;
