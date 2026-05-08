import gql from "fake-tag";
import { createClient } from "graphql-sse";
import { http, passthrough } from "msw";

import { signToken } from "@/auth/token";
import { db } from "@/db";
import { InvestmentPrices } from "@/db/schema/investments";
import { router } from "@/router";
import { graphql, runGql } from "#test/gql";

import { useMswServer } from "../../../test/msw";

// The SSE handler routes demo sessions to `getDemoDb(database)`, which would
// otherwise try to open a connection to a non-existent `demo_test` Postgres
// database. Point it at the real test DB so the subscription's writes flow
// through the same pool the test setup queries.
vi.mock("@/db/demo-db", async () => {
  const { defaultDb } = await import("@/db/client");
  return {
    getDemoDb: () => defaultDb,
    forgetDemoDb: () => {},
  };
});

const msw = useMswServer();

let baseUrl: string;

beforeAll(async () => {
  await router.ready();
  baseUrl = await router.listen({ port: 0, host: "127.0.0.1" });
  msw.use(http.all(`${baseUrl}/*`, () => passthrough()));
});

afterAll(async () => {
  await router.close();
});

const CreateInvestmentDoc = graphql(`
  mutation {
    investmentCreate(
      name: "Apple"
      currency: "GBP"
      asset: { stock: { code: "AAPL" } }
    ) {
      id
    }
  }
`);

const CreateAssetDoc = graphql(`
  mutation {
    netWorthCategoryCreate(input: { asset: { name: "ISA", type: STOCK } }) {
      id
    }
  }
`);

const BuyDoc = graphql(`
  mutation ($i: ID!, $a: ID!, $units: Float!, $price: Float!) {
    investmentTransactionCreate(
      investmentId: $i
      assetId: $a
      date: "2024-01-01"
      units: $units
      price: { amount: $price, currency: "GBP" }
    ) {
      id
    }
  }
`);

const SUBSCRIPTION = gql`
  subscription {
    portfolioLive {
      portfolio {
        totalValue {
          amount
        }
        dailyGainValue {
          amount
        }
      }
    }
  }
`;

type TickShape = {
  portfolioLive: {
    portfolio: {
      totalValue: { amount: number } | null;
      dailyGainValue: { amount: number } | null;
    };
  };
};

const DEMO_TOKEN = signToken({
  kind: "demo",
  database: "demo_test",
  flavour: "test",
});

/** Apollo / graphql-sse / fastify all call `Math.random` for unrelated
 * housekeeping (request ids, retry jitter, …) so a blanket mock would burn
 * through the planned sequence before the walk's own draw. Restrict the
 * stub to calls originating inside `jitterDemoLiveQuotes`; everyone else
 * gets the real PRNG. */
const TICK_MS = 30_000;
const RANDOM_SEQUENCE = [
  0.35495185782107097, 0.1730203302785298, 0.024161510508471595,
  0.8293004027390178, 0.7464111361019885, 0.5321456060688616,
  0.5521701250497973, 0.16237177557289662, 0.722670807405972,
  0.8123705831349832,
];

it("demo portfolioLive emits a deterministic random walk anchored on the cached close", async () => {
  const realRandom = Math.random.bind(Math);
  let walkIndex = 0;
  vi.spyOn(Math, "random").mockImplementation(() => {
    if (new Error().stack?.includes("jitterDemoLiveQuotes")) {
      return RANDOM_SEQUENCE[walkIndex++] ?? 0.5;
    }
    return realRandom();
  });

  // 10 units, cached close 1000 pence (£10/share). With no live overlay
  // the headline would be a flat £100 / £null — the walk diverges from
  // that baseline by ±0.5 % per tick.
  const { investmentCreate } = await runGql(CreateInvestmentDoc, {});
  const { netWorthCategoryCreate } = await runGql(CreateAssetDoc, {});
  await runGql(BuyDoc, {
    i: investmentCreate.id,
    a: netWorthCategoryCreate.id,
    units: 10,
    price: 5,
  });
  await db.insert(InvestmentPrices).values({
    investmentId: investmentCreate.id,
    date: new Date("2026-04-17"),
    price: 1000,
    currency: "GBP",
  });

  const sse = createClient({
    url: `${baseUrl}/graphql/stream`,
    headers: { authorization: `Bearer ${DEMO_TOKEN}` },
  });
  const iter = sse.iterate<TickShape>({ query: SUBSCRIPTION });
  const ticks: Array<{ totalValue: number | null; dailyGain: number | null }> =
    [];
  try {
    for (let i = 0; i < RANDOM_SEQUENCE.length; i++) {
      // The first tick is yielded immediately on subscribe; every
      // subsequent tick is gated behind `setTimeout(TICK_MS)` inside the
      // `portfolioLive` generator. Advance fake time past it so the
      // generator wakes up and runs the next walk step.
      if (i > 0) await vi.advanceTimersByTimeAsync(TICK_MS);
      const next = await iter.next();
      if (next.done || !next.value?.data) {
        throw new Error("subscription emitted no data");
      }
      const p = next.value.data.portfolioLive.portfolio;
      ticks.push({
        totalValue: p.totalValue?.amount ?? null,
        dailyGain: p.dailyGainValue?.amount ?? null,
      });
    }
  } finally {
    await iter.return?.();
    sse.dispose();
  }

  expect(ticks).toMatchInlineSnapshot(`
    [
      {
        "dailyGain": -0.14504814217892772,
        "totalValue": 99.85495185782106,
      },
      {
        "dailyGain": -0.3265053917852356,
        "totalValue": 99.52844646603585,
      },
      {
        "dailyGain": -0.4735946562783738,
        "totalValue": 99.05485180975745,
      },
      {
        "dailyGain": 0.326188025942065,
        "totalValue": 99.38103983569953,
      },
      {
        "dailyGain": 0.2448859493291252,
        "totalValue": 99.62592578502864,
      },
      {
        "dailyGain": 0.03202535764530694,
        "totalValue": 99.65795114267395,
      },
      {
        "dailyGain": 0.05199167773319004,
        "totalValue": 99.70994282040716,
      },
      {
        "dailyGain": -0.3366489095218185,
        "totalValue": 99.37329391088534,
      },
      {
        "dailyGain": 0.22127531589727595,
        "totalValue": 99.59456922678261,
      },
      {
        "dailyGain": 0.3111041366644713,
        "totalValue": 99.90567336344708,
      },
    ]
  `);
});
