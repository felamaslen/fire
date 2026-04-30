import { graphql, runGql } from "#test/gql";

async function createAsset(
  type: "CASH" | "STOCK" | "PENSION" = "STOCK",
  name = "ISA",
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
  return data.netWorthCategoryCreate.id;
}

async function createTransfer(
  assetIdFrom: string,
  assetIdTo: string,
  date = "2026-04-15",
): Promise<{ id: string; date: string }> {
  const data = await runGql(
    graphql(`
      mutation ($from: ID!, $to: ID!, $date: Date!) {
        assetStockTransferCreate(
          assetIdFrom: $from
          assetIdTo: $to
          date: $date
        ) {
          id
        }
      }
    `),
    { from: assetIdFrom, to: assetIdTo, date },
  );
  // The mutation returns a `Portfolio`; round-trip via the asset to read the
  // newly-created transfer's id and date.
  const after = await runGql(
    graphql(`
      query ($id: ID!) {
        netWorthCategoryAsset(id: $id) {
          transferOut {
            id
            date
          }
        }
      }
    `),
    { id: assetIdFrom },
  );
  // unused variable kept for narrowing
  void data;
  const out = after.netWorthCategoryAsset?.transferOut;
  if (!out) throw new Error("expected a transferOut");
  return { id: out.id, date: out.date };
}

describe("assetStockTransferCreate", () => {
  it("creates a transfer between two STOCK wrappers", async () => {
    const from = await createAsset("STOCK", "Old ISA");
    const to = await createAsset("STOCK", "New ISA");
    const created = await createTransfer(from, to, "2026-04-12");
    expect(created.date).toBe("2026-04-12");
  });

  it("exposes the transfer on both ends", async () => {
    const from = await createAsset("STOCK", "From");
    const to = await createAsset("STOCK", "To");
    await createTransfer(from, to, "2026-03-10");
    const data = await runGql(
      graphql(`
        query ($from: ID!, $to: ID!) {
          fromAsset: netWorthCategoryAsset(id: $from) {
            transferOut {
              date
              assetTo {
                id
              }
            }
            transfersIn {
              date
            }
          }
          toAsset: netWorthCategoryAsset(id: $to) {
            transferOut {
              date
            }
            transfersIn {
              date
              assetFrom {
                id
              }
            }
          }
        }
      `),
      { from, to },
    );
    expect(data.fromAsset?.transferOut).toMatchObject({
      date: "2026-03-10",
      assetTo: { id: to },
    });
    expect(data.fromAsset?.transfersIn).toEqual([]);
    expect(data.toAsset?.transferOut).toBeNull();
    expect(data.toAsset?.transfersIn).toMatchObject([
      { date: "2026-03-10", assetFrom: { id: from } },
    ]);
  });

  it("rejects when source already has an outgoing transfer", async () => {
    const from = await createAsset("STOCK", "Source");
    const to1 = await createAsset("STOCK", "Dest 1");
    const to2 = await createAsset("STOCK", "Dest 2");
    await createTransfer(from, to1);
    await expect(
      runGql(
        graphql(`
          mutation ($from: ID!, $to: ID!) {
            assetStockTransferCreate(
              assetIdFrom: $from
              assetIdTo: $to
              date: "2026-05-01"
            ) {
              id
            }
          }
        `),
        { from, to: to2 },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Asset ${from} already has an outgoing transfer]`,
    );
  });

  it("rejects when from == to", async () => {
    const a = await createAsset("STOCK");
    await expect(
      runGql(
        graphql(`
          mutation ($a: ID!) {
            assetStockTransferCreate(
              assetIdFrom: $a
              assetIdTo: $a
              date: "2026-05-01"
            ) {
              id
            }
          }
        `),
        { a },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: assetIdFrom and assetIdTo must be different]`,
    );
  });

  it("rejects a non-STOCK / non-PENSION wrapper", async () => {
    const from = await createAsset("CASH", "Current");
    const to = await createAsset("STOCK", "ISA");
    await expect(
      runGql(
        graphql(`
          mutation ($from: ID!, $to: ID!) {
            assetStockTransferCreate(
              assetIdFrom: $from
              assetIdTo: $to
              date: "2026-05-01"
            ) {
              id
            }
          }
        `),
        { from, to },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Asset ${from} must be STOCK or PENSION, got CASH]`,
    );
  });

  it("rejects an unknown asset id", async () => {
    const to = await createAsset("STOCK");
    await expect(
      runGql(
        graphql(`
          mutation ($to: ID!) {
            assetStockTransferCreate(
              assetIdFrom: "00000000-0000-0000-0000-000000000000"
              assetIdTo: $to
              date: "2026-05-01"
            ) {
              id
            }
          }
        `),
        { to },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Asset 00000000-0000-0000-0000-000000000000 not found]`,
    );
  });

  it("rejects creating a 2-cycle (A→B then B→A)", async () => {
    const a = await createAsset("STOCK", "A");
    const b = await createAsset("STOCK", "B");
    await createTransfer(a, b);
    await expect(
      runGql(
        graphql(`
          mutation ($from: ID!, $to: ID!) {
            assetStockTransferCreate(
              assetIdFrom: $from
              assetIdTo: $to
              date: "2026-05-01"
            ) {
              id
            }
          }
        `),
        { from: b, to: a },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Transfer would create a cycle through asset ${b}]`,
    );
  });

  it("rejects creating a 3-cycle (A→B, B→C, then C→A)", async () => {
    const a = await createAsset("STOCK", "A");
    const b = await createAsset("STOCK", "B");
    const c = await createAsset("STOCK", "C");
    await createTransfer(a, b);
    await createTransfer(b, c);
    await expect(
      runGql(
        graphql(`
          mutation ($from: ID!, $to: ID!) {
            assetStockTransferCreate(
              assetIdFrom: $from
              assetIdTo: $to
              date: "2026-05-01"
            ) {
              id
            }
          }
        `),
        { from: c, to: a },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Transfer would create a cycle through asset ${c}]`,
    );
  });
});

describe("assetStockTransferUpdate", () => {
  it("updates only the date", async () => {
    const from = await createAsset("STOCK", "From");
    const to = await createAsset("STOCK", "To");
    await createTransfer(from, to, "2026-01-10");
    await runGql(
      graphql(`
        mutation ($from: ID!) {
          assetStockTransferUpdate(assetIdFrom: $from, date: "2026-06-01") {
            id
          }
        }
      `),
      { from },
    );
    const after = await runGql(
      graphql(`
        query ($id: ID!) {
          netWorthCategoryAsset(id: $id) {
            transferOut {
              date
              assetTo {
                id
              }
            }
          }
        }
      `),
      { id: from },
    );
    expect(after.netWorthCategoryAsset?.transferOut).toMatchObject({
      date: "2026-06-01",
      assetTo: { id: to },
    });
  });

  it("rejects when no outgoing transfer exists", async () => {
    const a = await createAsset("STOCK");
    await expect(
      runGql(
        graphql(`
          mutation ($from: ID!) {
            assetStockTransferUpdate(assetIdFrom: $from, date: "2026-06-01") {
              id
            }
          }
        `),
        { from: a },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: No outgoing transfer for asset ${a}]`,
    );
  });
});

describe("assetStockTransferDelete", () => {
  it("removes the transfer", async () => {
    const from = await createAsset("STOCK", "From");
    const to = await createAsset("STOCK", "To");
    await createTransfer(from, to);
    await runGql(
      graphql(`
        mutation ($from: ID!, $to: ID!) {
          assetStockTransferDelete(assetIdFrom: $from, assetIdTo: $to) {
            id
          }
        }
      `),
      { from, to },
    );
    const after = await runGql(
      graphql(`
        query ($id: ID!) {
          netWorthCategoryAsset(id: $id) {
            transferOut {
              id
            }
          }
        }
      `),
      { id: from },
    );
    expect(after.netWorthCategoryAsset?.transferOut).toBeNull();
  });

  it("rejects when assetIdTo doesn't match", async () => {
    const from = await createAsset("STOCK", "From");
    const to = await createAsset("STOCK", "To");
    const other = await createAsset("STOCK", "Other");
    await createTransfer(from, to);
    await expect(
      runGql(
        graphql(`
          mutation ($from: ID!, $to: ID!) {
            assetStockTransferDelete(assetIdFrom: $from, assetIdTo: $to) {
              id
            }
          }
        `),
        { from, to: other },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: Transfer from ${from} does not point to ${other}]`,
    );
  });

  it("rejects when no outgoing transfer exists", async () => {
    const a = await createAsset("STOCK");
    const b = await createAsset("STOCK");
    await expect(
      runGql(
        graphql(`
          mutation ($from: ID!, $to: ID!) {
            assetStockTransferDelete(assetIdFrom: $from, assetIdTo: $to) {
              id
            }
          }
        `),
        { from: a, to: b },
      ),
    ).rejects.toThrowErrorMatchingInlineSnapshot(
      `[Error: GraphQL errors: No outgoing transfer for asset ${a}]`,
    );
  });
});
