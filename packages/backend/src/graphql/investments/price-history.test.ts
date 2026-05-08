import { db } from "@/db";
import {
  InvestmentPrices,
  Investments,
  InvestmentStockSplits,
} from "@/db/schema/investments";
import { graphql, runGql } from "#test/gql";

async function createInvestment(code: string): Promise<string> {
  const [row] = await db
    .insert(Investments)
    .values({ name: code, stockCode: code, currency: "GBP" })
    .returning({ id: Investments.id });
  return row.id;
}

async function insertPrice(
  investmentId: string,
  date: string,
  price: number,
): Promise<void> {
  await db.insert(InvestmentPrices).values({
    investmentId,
    date: new Date(date),
    price,
    currency: "GBP",
  });
}

const PriceHistoryDocument = graphql(`
  query InvestmentPriceHistory {
    investments {
      edges {
        node {
          name
          priceHistory {
            currency
            initialDate
            points {
              x
              y
            }
          }
        }
      }
    }
  }
`);

it("returns null when no prices have been recorded", async () => {
  await createInvestment("EMPTY");
  const data = await runGql(PriceHistoryDocument, {});
  expect(data.investments?.edges[0].node.priceHistory).toBeNull();
});

it("returns split-adjusted prices in major units, oldest first, with x as days since initialDate", async () => {
  // Stored prices are in minor units (pence). After a 2-for-1 split on
  // 2024-06-01 the pre-split row's `priceAdjusted` is halved by trigger.
  const id = await createInvestment("SPLT");
  await insertPrice(id, "2024-01-01", 200); // pre-split, 200p raw → 100p adjusted
  await insertPrice(id, "2024-12-01", 110); // post-split, 110p raw → 110p adjusted
  await db
    .insert(InvestmentStockSplits)
    .values({ investmentId: id, date: new Date("2024-06-01"), ratio: "2" });

  const data = await runGql(PriceHistoryDocument, {});
  const node = data.investments?.edges.find(
    (e) => e.node.name === "SPLT",
  )?.node;
  expect(node?.priceHistory).toMatchInlineSnapshot(`
    {
      "currency": "GBP",
      "initialDate": "2024-01-01",
      "points": [
        {
          "x": 0,
          "y": 1,
        },
        {
          "x": 335,
          "y": 1.1,
        },
      ],
    }
  `);
});
