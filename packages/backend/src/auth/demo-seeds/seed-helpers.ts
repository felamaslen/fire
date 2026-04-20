import { addMonths, startOfMonth } from "date-fns";

import type { DB } from "@/db";
import {
  NetWorthCategoryAssets,
  NetWorthCategoryLiabilities,
  NetWorthEntries,
  NetWorthValueAmounts,
  NetWorthValues,
} from "@/db/schema/net-worth";
import {
  PlanningAccounts,
  PlanningBills,
  PlanningEarnings,
  PlanningMonths,
  PlanningYears,
  PlanningYearUKTaxRates,
} from "@/db/schema/planning";

/** Deterministic seeded PRNG (Mulberry32). Seeded from the flavour name so two demo logins on the same flavour get identical data, which makes screenshots / tests stable across reseeds. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pence, as stored in the DB's `bigint` money columns. */
export type Pence = number;

export type AssetSpec = {
  name: string;
  type:
    | "CASH"
    | "STOCK"
    | "PENSION"
    | "PROPERTY"
    | "VEHICLE"
    | "MISC"
    | "OPTION";
  /** Starting value in pence at `startOffsetMonths` months before today. */
  startValue: Pence;
  /** Current value in pence as of `today`. Linearly interpolated per month between start and today. Small PRNG-driven jitter is applied per month. */
  endValue: Pence;
  /** Treat this asset as a planning account (CASH only). Earnings / bills will fall back to this if no explicit account is given. */
  planningAccount?: boolean;
};

export type LiabilitySpec = {
  name: string;
  type: "CREDIT_CARD" | "LOAN" | "MISC";
  /** Positive pence, stored as positive amount on a liability row. */
  startValue: Pence;
  endValue: Pence;
  /** APR percent (e.g. 5.25 for 5.25%). Required for `LOAN`. */
  interestRate?: number;
};

export type BillSpec = {
  name: string;
  /** Monthly amount in pence. */
  amount: Pence;
  /** Day-of-month the bill collects. 1-28 safe range. */
  dayOfMonth: number;
};

export type EarningsSpec = {
  name: string;
  /** Gross annual pay in pence. `PlanningEarnings.amountGross` is per-year, not per-pay-period. */
  yearly: Pence;
};

export type FlavourSpec = {
  /** How many months of history to populate, counting backwards from the month of `today`. */
  historyMonths: number;
  assets: AssetSpec[];
  liabilities: LiabilitySpec[];
  bills: BillSpec[];
  earnings: EarningsSpec[];
};

/** UK tax parameters — reasonable defaults for FY25/26 style numbers. Values in fractional pence. */
const DEFAULT_UK_TAX_RATES = {
  rateBasic: 0.2,
  rateHigher: 0.4,
  rateAdditional: 0.45,
  thresholdBasic: 3750000, // £37,500
  thresholdHigher: 12527000, // £125,270
  thresholdAdditional: 12527000,
  rateNicMain: 0.08,
  rateNicAdditional: 0.02,
  thresholdNicPrimary: 1257000,
  thresholdNicUpperEarnings: 5027000,
  rateStudentLoanPlan2: 0.09,
  thresholdStudentLoanPlan2: 2729500,
  thresholdPersonalAllowanceTaper: 10000000,
};

/** Compute the UK financial-year start year for `today`. FY runs 6 April → 5 April. */
function ukFinancialYear(today: Date): number {
  const y = today.getUTCFullYear();
  const apr6 = Date.UTC(y, 3, 6);
  return today.getTime() >= apr6 ? y : y - 1;
}

/** Insert seed data for a flavour. Runs against the demo session's dedicated database (see `demo-database.ts`). */
export async function applyFlavour(
  db: DB,
  today: Date,
  spec: FlavourSpec,
): Promise<void> {
  const rand = prng(hashSeed(JSON.stringify(spec)));

  // ── Planning year + UK tax rates ──────────────────────────────────────────
  const fy = ukFinancialYear(today);
  await db.insert(PlanningYears).values({ year: fy });
  await db.insert(PlanningYears).values({ year: fy + 1 });
  await db
    .insert(PlanningYearUKTaxRates)
    .values({ year: fy, ...DEFAULT_UK_TAX_RATES });
  await db
    .insert(PlanningYearUKTaxRates)
    .values({ year: fy + 1, ...DEFAULT_UK_TAX_RATES });

  for (const year of [fy, fy + 1]) {
    const months = Array.from({ length: 12 }, (_, i) => {
      // UK FY month 0 = April (month 3 in JS Date).
      const m = (3 + i) % 12;
      const yy = m < 3 ? year + 1 : year;
      return { year, date: new Date(Date.UTC(yy, m, 1)) };
    });
    await db.insert(PlanningMonths).values(months);
  }

  // ── Assets ────────────────────────────────────────────────────────────────
  const assetIdByName = new Map<string, string>();
  for (const asset of spec.assets) {
    const [row] = await db
      .insert(NetWorthCategoryAssets)
      .values({ name: asset.name, type: asset.type })
      .returning({ id: NetWorthCategoryAssets.id });
    assetIdByName.set(asset.name, row.id);
  }
  const planningAssetNames = spec.assets
    .filter((a) => a.planningAccount)
    .map((a) => a.name);
  for (const name of planningAssetNames) {
    await db
      .insert(PlanningAccounts)
      .values({ accountId: assetIdByName.get(name)! });
  }
  const defaultPlanningAsset = planningAssetNames[0];
  if (!defaultPlanningAsset) {
    throw new Error(`Flavour has no planning account: ${JSON.stringify(spec)}`);
  }
  const defaultPlanningAccountId = assetIdByName.get(defaultPlanningAsset)!;

  // ── Liabilities ───────────────────────────────────────────────────────────
  const liabilityIdByName = new Map<string, string>();
  for (const liab of spec.liabilities) {
    const [row] = await db
      .insert(NetWorthCategoryLiabilities)
      .values({
        name: liab.name,
        type: liab.type,
        interestRate:
          liab.type === "LOAN" && liab.interestRate != null
            ? liab.interestRate.toFixed(4)
            : null,
      })
      .returning({ id: NetWorthCategoryLiabilities.id });
    liabilityIdByName.set(liab.name, row.id);
  }

  // ── Net-worth entries (monthly history + current month) ───────────────────
  const firstMonth = startOfMonth(addMonths(today, -(spec.historyMonths - 1)));
  const totalMonths = spec.historyMonths;
  for (let i = 0; i < totalMonths; i++) {
    const monthDate = addMonths(firstMonth, i);
    const [entry] = await db
      .insert(NetWorthEntries)
      .values({ date: monthDate })
      .returning({ id: NetWorthEntries.id });
    const progress = totalMonths === 1 ? 1 : i / (totalMonths - 1);

    for (const asset of spec.assets) {
      const linear =
        asset.startValue + (asset.endValue - asset.startValue) * progress;
      const jitter = 1 + (rand() - 0.5) * 0.04;
      const amount = Math.round(linear * jitter);
      const [value] = await db
        .insert(NetWorthValues)
        .values({
          entryId: entry.id,
          categoryAssetId: assetIdByName.get(asset.name)!,
        })
        .returning({ id: NetWorthValues.id });
      await db
        .insert(NetWorthValueAmounts)
        .values({ valueId: value.id, amount, currency: "GBP" });
    }

    for (const liab of spec.liabilities) {
      const linear =
        liab.startValue + (liab.endValue - liab.startValue) * progress;
      const jitter = 1 + (rand() - 0.5) * 0.02;
      const amount = Math.round(linear * jitter);
      const [value] = await db
        .insert(NetWorthValues)
        .values({
          entryId: entry.id,
          categoryLiabilityId: liabilityIdByName.get(liab.name)!,
        })
        .returning({ id: NetWorthValues.id });
      await db
        .insert(NetWorthValueAmounts)
        .values({ valueId: value.id, amount, currency: "GBP" });
    }
  }

  // ── Recurring bills ───────────────────────────────────────────────────────
  for (const bill of spec.bills) {
    await db.insert(PlanningBills).values({
      name: bill.name,
      start: addMonths(today, -12),
      frequency: "MONTHLY",
      collectionDate: String(bill.dayOfMonth),
      amount: bill.amount,
      currency: "GBP",
      fromAccountId: defaultPlanningAccountId,
    });
  }

  // ── Earnings streams ─────────────────────────────────────────────────────
  for (const e of spec.earnings) {
    await db.insert(PlanningEarnings).values({
      name: e.name,
      start: addMonths(today, -24),
      amountGross: e.yearly,
      currency: "GBP",
      countryCode: "GB",
      toAccountId: defaultPlanningAccountId,
    });
  }
}
