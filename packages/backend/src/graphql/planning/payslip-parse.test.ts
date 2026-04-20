import { readFileSync } from "node:fs";
import path from "node:path";

// The module under test imports `@google/genai`, which in turn expects to be
// able to construct a real client. We never want the test to hit the wire —
// so we stub the whole module: `Type` (used by the resolver's response schema)
// keeps its real values, but `GoogleGenAI` is replaced with a class whose
// `models.generateContent` returns a fixture captured from a real run.
//
// `mockGenerateContent` is a vi.fn so individual tests can override / inspect
// the call (args, return value) as needed.
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

import { _resetPayslipParseCacheForTests } from "./payslip-parse";

const PAYSLIP_FIXTURE = path.join(__dirname, "__fixtures__/payslip.pdf");
const GEMINI_FIXTURE = JSON.parse(
  readFileSync(
    path.join(__dirname, "__fixtures__/payslip-parse.gemini.json"),
    "utf8",
  ),
);
const GEMINI_FIXTURE_2 = JSON.parse(
  readFileSync(
    path.join(__dirname, "__fixtures__/payslip-parse2.gemini.json"),
    "utf8",
  ),
);

function mockGeminiResponse(payload: unknown): void {
  mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(payload) });
}

async function createAsset(name: string): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!) {
        netWorthCategoryCreate(input: { asset: { name: $name, type: CASH } }) {
          id
        }
      }
    `),
    { name },
  );
  return data.netWorthCategoryCreate.id;
}

async function createLoanLiability(name: string): Promise<string> {
  const data = await runGql(
    graphql(`
      mutation ($name: String!) {
        netWorthCategoryCreate(
          input: { liability: { name: $name, type: LOAN, interestRate: 6.0 } }
        ) {
          id
        }
      }
    `),
    { name },
  );
  return data.netWorthCategoryCreate.id;
}

async function assign(assetId: string, alias: string | null): Promise<void> {
  await runGql(
    graphql(`
      mutation ($id: ID!, $alias: String) {
        planningAccountAssign(assetId: $id, alias: $alias) {
          id
        }
      }
    `),
    { id: assetId, alias },
  );
}

const ParseMutation = graphql(`
  mutation ParsePayslip($file: Upload!) {
    payslipParse(file: $file) {
      gross {
        amount
        currency
      }
      date
      suggestedName
      employeeFirstName
      suggestedAccount {
        id
      }
      adjustments {
        name
        amount {
          amount
          currency
        }
        liability {
          id
        }
      }
    }
  }
`);

beforeEach(() => {
  mockGenerateContent.mockReset();
  _resetPayslipParseCacheForTests();
});

it("parses the Gemini response into the PayslipParseResult shape", async () => {
  mockGeminiResponse(GEMINI_FIXTURE);

  const { payslipParse } = await runGql(ParseMutation, {
    file: new TestUpload(PAYSLIP_FIXTURE),
  });

  // Gemini was called exactly once with a PDF part + the prompt.
  expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  const call = mockGenerateContent.mock.calls[0][0];
  expect(call.model).toBe("gemini-2.5-flash-lite");
  const parts = call.contents[0].parts;
  expect(parts[0].inlineData.mimeType).toBe("application/pdf");
  expect(typeof parts[0].inlineData.data).toBe("string");
  expect(parts[1].text).toContain("UK-style payslip");

  // Gross / date pass through unchanged (just Money-wrapped).
  expect(payslipParse.gross).toEqual({ amount: 7307.69, currency: "GBP" });
  expect(payslipParse.date).toBe("2025-07-31");

  // `Salary (<first name>)` pre-formatting.
  expect(payslipParse.employeeFirstName).toBe("F");
  expect(payslipParse.suggestedName).toBe("Salary (F)");

  // No matching planning account seeded → suggestedAccount stays null.
  expect(payslipParse.suggestedAccount).toBeNull();

  // Each fixture adjustment comes through, in order, with its amount / name.
  expect(payslipParse.adjustments.map((a) => a.name)).toEqual([
    "Income Tax",
    "National Insurance",
    "Student Loan",
  ]);
  expect(payslipParse.adjustments.map((a) => a.amount.amount)).toEqual([
    -1094.86, -313.65, -462,
  ]);
  // With no matching liability in the DB, the student-loan line still has a
  // null liability.
  expect(payslipParse.adjustments.every((a) => a.liability === null)).toBe(
    true,
  );
});

it("matches suggestedAccount when a planning account's name contains the extracted first name", async () => {
  // Planning account "F (main)" → the `\yF\y` match in `matchAccountByName`
  // should hit.
  const assetId = await createAsset("F (main)");
  await assign(assetId, null);

  mockGeminiResponse(GEMINI_FIXTURE);

  const { payslipParse } = await runGql(ParseMutation, {
    file: new TestUpload(PAYSLIP_FIXTURE),
  });

  expect(payslipParse.suggestedAccount).toEqual({ id: assetId });
});

it("populates adjustment.liability for a Student Loan line when a matching liability exists", async () => {
  const liabilityId = await createLoanLiability("Student Loan");

  mockGeminiResponse(GEMINI_FIXTURE);

  const { payslipParse } = await runGql(ParseMutation, {
    file: new TestUpload(PAYSLIP_FIXTURE),
  });

  const sl = payslipParse.adjustments.find((a) => a.name === "Student Loan")!;
  expect(sl.liability).toEqual({ id: liabilityId });
  // Non-SL lines still resolve to null.
  const nonSl = payslipParse.adjustments.filter(
    (a) => a.name !== "Student Loan",
  );
  expect(nonSl.every((a) => a.liability === null)).toBe(true);
});

it("memoises the Gemini response by PDF hash — re-uploading the same file doesn't hit the model twice", async () => {
  mockGeminiResponse(GEMINI_FIXTURE);

  await runGql(ParseMutation, { file: new TestUpload(PAYSLIP_FIXTURE) });
  await runGql(ParseMutation, { file: new TestUpload(PAYSLIP_FIXTURE) });

  expect(mockGenerateContent).toHaveBeenCalledTimes(1);
});

it("collapses duplicate-label adjustments (e.g. two Pension lines from a payslip with two pension schemes) into a single summed row", async () => {
  mockGeminiResponse(GEMINI_FIXTURE_2);

  const { payslipParse } = await runGql(ParseMutation, {
    file: new TestUpload(PAYSLIP_FIXTURE),
  });

  // The raw fixture has two `Pension` lines (-39.98 and -53.30) — the
  // resolver sums them into a single line so the review form doesn't show
  // the same label twice.
  expect(payslipParse.adjustments.map((a) => a.name)).toEqual([
    "Income Tax",
    "N.I",
    "Pension",
  ]);
  const pension = payslipParse.adjustments.find((a) => a.name === "Pension")!;
  expect(pension.amount.amount).toBeCloseTo(-93.28, 2);
});

it("retries on 503 UNAVAILABLE and succeeds if a later attempt returns", async () => {
  const unavailable = new Error(
    `{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}`,
  );
  mockGenerateContent
    .mockRejectedValueOnce(unavailable)
    .mockRejectedValueOnce(unavailable)
    .mockResolvedValueOnce({ text: JSON.stringify(GEMINI_FIXTURE) });

  const { payslipParse } = await runGql(ParseMutation, {
    file: new TestUpload(PAYSLIP_FIXTURE),
  });

  expect(mockGenerateContent).toHaveBeenCalledTimes(3);
  expect(payslipParse.gross.amount).toBe(7307.69);
}, 30_000);

it("surfaces Gemini quota-exhaustion errors with a clear message", async () => {
  mockGenerateContent.mockRejectedValueOnce(
    // Shape matches what `@google/genai` throws on a 429.
    new Error(
      `{"error":{"code":429,"message":"quota exceeded","status":"RESOURCE_EXHAUSTED"}}`,
    ),
  );

  await expect(
    runGql(ParseMutation, { file: new TestUpload(PAYSLIP_FIXTURE) }),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `[Error: GraphQL errors: Gemini quota exhausted — try again later.]`,
  );
});
