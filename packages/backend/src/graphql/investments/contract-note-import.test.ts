import path from "node:path";

const mockGenerateContent = vi.fn();
vi.mock("@google/genai", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@google/genai");
  return {
    ...actual,
    GoogleGenAI: class {
      readonly models = { generateContent: mockGenerateContent };
    },
  };
});

import "@/index";

import { graphql, runGql } from "#test/gql";
import { TestUpload } from "#test/upload";

import { _resetContractNoteImportCacheForTests } from "./contract-note-import";

// Gemini is mocked, so the PDF body is never inspected — a tiny stub PDF
// alongside this test is enough to drive the upload pipeline.
const FIXTURE_PATH = path.join(__dirname, "__fixtures__/contract-note.pdf");

const ImportMutation = graphql(`
  mutation ImportContractNote($file: Upload!, $investmentId: ID) {
    investmentContractNoteImport(file: $file, investmentId: $investmentId) {
      investment {
        id
      }
      asset {
        id
      }
      date
      units
      drip
      fileKey
      price {
        amount
        currency
      }
      taxes {
        amount
        currency
      }
      fees {
        amount
        currency
      }
    }
  }
`);

function mockGeminiResponse(payload: unknown): void {
  mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(payload) });
}

async function createInvestment(opts: {
  name: string;
  ticker: string;
  currency?: string;
}): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!, $ticker: String!, $currency: String!) {
        investmentCreate(
          name: $name
          currency: $currency
          asset: { stock: { code: $ticker } }
        ) {
          id
        }
      }
    `),
    { name: opts.name, ticker: opts.ticker, currency: opts.currency ?? "GBP" },
  );
  return data.investmentCreate.id;
}

async function createWrapper(
  name: string,
  type: "STOCK" | "PENSION" = "STOCK",
  /** When set, books a tiny seed transaction against this investment so the wrapper qualifies as a candidate (the resolver only surfaces wrappers that already have at least one `InvestmentTransaction`). */
  seedInvestmentId?: string,
): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!, $type: NetWorthAssetType!) {
        netWorthCategoryCreate(input: { asset: { name: $name, type: $type } }) {
          id
        }
      }
    `),
    { name, type },
  );
  const wrapperId = data.netWorthCategoryCreate.id;
  if (seedInvestmentId) {
    await bookTransaction({
      investmentId: seedInvestmentId,
      assetId: wrapperId,
      date: "2020-01-01",
      units: 1,
      priceAmount: 1,
    });
  }
  return wrapperId;
}

async function bookTransaction(opts: {
  investmentId: string;
  assetId: string;
  date: string;
  units: number;
  priceAmount: number;
  drip?: boolean;
}): Promise<void> {
  await runGql(
    graphql(`
      mutation (
        $investmentId: ID!
        $assetId: ID!
        $date: Date!
        $units: Float!
        $priceAmount: Float!
        $drip: Boolean
      ) {
        investmentTransactionCreate(
          investmentId: $investmentId
          assetId: $assetId
          date: $date
          units: $units
          price: { amount: $priceAmount, currency: "GBP" }
          drip: $drip
        ) {
          id
        }
      }
    `),
    { ...opts, drip: opts.drip ?? null },
  );
}

beforeEach(() => {
  mockGenerateContent.mockReset();
  _resetContractNoteImportCacheForTests();
});

it("parses Gemini's response, matches investment + wrapper, and converts GBp prices to GBP majors", async () => {
  const investmentId = await createInvestment({
    name: "Apple",
    ticker: "AAPL",
  });
  const wrapperId = await createWrapper("ISA", "STOCK", investmentId);

  mockGeminiResponse({
    direction: "BUY",
    units: 10,
    price: { amount: 152, currency: "GBp" },
    taxes: { amount: 7.6, currency: "GBP" },
    fees: { amount: 4.99, currency: "GBP" },
    date: "2025-04-12",
    investmentId,
    assetId: wrapperId,
  });

  const { investmentContractNoteImport: result } = await runGql(
    ImportMutation,
    {
      file: new TestUpload(FIXTURE_PATH),
      investmentId: null,
    },
  );

  expect(result.investment).toEqual({ id: investmentId });
  expect(result.asset).toEqual({ id: wrapperId });
  expect(result.date).toBe("2025-04-12");
  expect(result.units).toBe(10);
  // 152 GBp normalised to £1.52.
  expect(result.price).toEqual({ amount: 1.52, currency: "GBP" });
  expect(result.taxes).toEqual({ amount: 7.6, currency: "GBP" });
  expect(result.fees).toEqual({ amount: 4.99, currency: "GBP" });
  // No history, so DRIP stays false.
  expect(result.drip).toBe(false);
  // The upload was persisted to the bucket; we get back an opaque key the
  // frontend re-passes to `investmentTransactionCreate.fileKey`.
  expect(result.fileKey).toMatch(/contract-note\.pdf$/);
});

it("attaches the imported file to a transaction created with the returned fileKey", async () => {
  const investmentId = await createInvestment({
    name: "Apple",
    ticker: "AAPL",
  });
  const wrapperId = await createWrapper("ISA", "STOCK", investmentId);

  mockGeminiResponse({
    direction: "BUY",
    units: 1,
    price: { amount: 100, currency: "GBP" },
    date: "2025-01-01",
    investmentId,
    assetId: wrapperId,
  });

  const { investmentContractNoteImport: parsed } = await runGql(
    ImportMutation,
    { file: new TestUpload(FIXTURE_PATH), investmentId: null },
  );

  const created = await runGql(
    graphql(`
      mutation ($investmentId: ID!, $assetId: ID!, $fileKey: String!) {
        investmentTransactionCreate(
          investmentId: $investmentId
          assetId: $assetId
          date: "2025-01-01"
          units: 1
          price: { amount: 1, currency: "GBP" }
          fileKey: $fileKey
        ) {
          id
          fileUrl
        }
      }
    `),
    { investmentId, assetId: wrapperId, fileKey: parsed.fileKey },
  );

  // The signed URL is path-prefixed `/files/<key>?…sig…` — surface as truthy.
  expect(created.investmentTransactionCreate.fileUrl).toMatch(/^\/files\//);
});

it("preserves sub-penny precision in the unit price — a 15.66392p quote round-trips as 0.1566392 GBP", async () => {
  const investmentId = await createInvestment({
    name: "Apple",
    ticker: "AAPL",
  });

  mockGeminiResponse({
    direction: "BUY",
    units: 100,
    // Real-world example: a fractional-share platform fills at sub-penny
    // tick sizes. The resolver must surface every digit so the review form
    // shows what's printed on the contract note (and the float-precision
    // `InvestmentTransactions.price` column can store it without rounding).
    price: { amount: 15.66392, currency: "GBp" },
    date: "2025-04-12",
    investmentId,
    assetId: null,
  });

  const { investmentContractNoteImport: result } = await runGql(
    ImportMutation,
    {
      file: new TestUpload(FIXTURE_PATH),
      investmentId: null,
    },
  );

  // 15.66392 GBp = 0.1566392 GBP — no rounding to 0.16.
  expect(result.price.currency).toBe("GBP");
  expect(result.price.amount).toBeCloseTo(0.1566392, 10);
});

it("locks investment when an explicit investmentId is supplied, even if Gemini suggests a different match", async () => {
  const target = await createInvestment({ name: "Apple", ticker: "AAPL" });
  const other = await createInvestment({ name: "Microsoft", ticker: "MSFT" });

  mockGeminiResponse({
    direction: "BUY",
    units: 1,
    price: { amount: 100, currency: "GBP" },
    date: "2025-01-01",
    investmentId: other,
    assetId: null,
  });

  const { investmentContractNoteImport: result } = await runGql(
    ImportMutation,
    {
      file: new TestUpload(FIXTURE_PATH),
      investmentId: target,
    },
  );

  expect(result.investment).toEqual({ id: target });
});

it("flips units negative for a SELL contract note", async () => {
  const investmentId = await createInvestment({
    name: "Apple",
    ticker: "AAPL",
  });

  mockGeminiResponse({
    direction: "SELL",
    units: 5,
    price: { amount: 200, currency: "GBp" },
    date: "2025-02-02",
    investmentId,
    assetId: null,
  });

  const { investmentContractNoteImport: result } = await runGql(
    ImportMutation,
    {
      file: new TestUpload(FIXTURE_PATH),
      investmentId: null,
    },
  );
  expect(result.units).toBe(-5);
  expect(result.drip).toBe(false);
});

it("infers drip=true when the buy consideration is small relative to the recent DRIP history", async () => {
  const investmentId = await createInvestment({
    name: "Apple",
    ticker: "AAPL",
  });
  const assetId = await createWrapper("ISA");

  // Seed three historical DRIPs at ~£10 consideration each (1 unit @ £10).
  for (const date of ["2025-01-15", "2025-02-15", "2025-03-15"]) {
    await bookTransaction({
      investmentId,
      assetId,
      date,
      units: 1,
      priceAmount: 10,
      drip: true,
    });
  }

  // New trade: 1 unit @ £12 = £12 consideration. EWMA ≈ £10, threshold = 3*EWMA = £30
  // → £12 < £30 ⇒ DRIP.
  mockGeminiResponse({
    direction: "BUY",
    units: 1,
    price: { amount: 12, currency: "GBP" },
    date: "2025-04-15",
    investmentId,
    assetId,
  });

  const { investmentContractNoteImport: result } = await runGql(
    ImportMutation,
    {
      file: new TestUpload(FIXTURE_PATH),
      investmentId: null,
    },
  );
  expect(result.drip).toBe(true);
});

it("infers drip=false for a regular contribution-sized buy when only DRIP history exists", async () => {
  const investmentId = await createInvestment({
    name: "Apple",
    ticker: "AAPL",
  });
  const assetId = await createWrapper("ISA");

  for (const date of ["2025-01-15", "2025-02-15"]) {
    await bookTransaction({
      investmentId,
      assetId,
      date,
      units: 1,
      priceAmount: 10,
      drip: true,
    });
  }
  // £500 trade is way above 3×EWMA(£10), should NOT be flagged as DRIP.
  mockGeminiResponse({
    direction: "BUY",
    units: 5,
    price: { amount: 100, currency: "GBP" },
    date: "2025-04-15",
    investmentId,
    assetId,
  });

  const { investmentContractNoteImport: result } = await runGql(
    ImportMutation,
    {
      file: new TestUpload(FIXTURE_PATH),
      investmentId: null,
    },
  );
  expect(result.drip).toBe(false);
});

it("falls back to the last 20 contributions when no DRIP history exists, flagging tiny buys as DRIPs", async () => {
  const investmentId = await createInvestment({
    name: "Apple",
    ticker: "AAPL",
  });
  const assetId = await createWrapper("ISA");

  // Seed three contributions at ~£1000 each.
  for (const date of ["2025-01-15", "2025-02-15", "2025-03-15"]) {
    await bookTransaction({
      investmentId,
      assetId,
      date,
      units: 10,
      priceAmount: 100,
    });
  }

  // £50 trade < 0.1 × £1000 = £100 ⇒ flagged as DRIP.
  mockGeminiResponse({
    direction: "BUY",
    units: 1,
    price: { amount: 50, currency: "GBP" },
    date: "2025-04-15",
    investmentId,
    assetId,
  });

  const { investmentContractNoteImport: result } = await runGql(
    ImportMutation,
    {
      file: new TestUpload(FIXTURE_PATH),
      investmentId: null,
    },
  );
  expect(result.drip).toBe(true);
});

it("memoises the Gemini response by PDF hash + investmentId — re-uploading doesn't hit the model twice", async () => {
  await createInvestment({ name: "Apple", ticker: "AAPL" });

  mockGeminiResponse({
    direction: "BUY",
    units: 1,
    price: { amount: 100, currency: "GBP" },
    date: "2025-01-01",
    investmentId: null,
    assetId: null,
  });

  await runGql(ImportMutation, {
    file: new TestUpload(FIXTURE_PATH),
    investmentId: null,
  });
  await runGql(ImportMutation, {
    file: new TestUpload(FIXTURE_PATH),
    investmentId: null,
  });

  expect(mockGenerateContent).toHaveBeenCalledTimes(1);
});
