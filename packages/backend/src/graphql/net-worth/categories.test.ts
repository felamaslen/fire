import gql from "fake-tag";
import { createClient } from "graphql-sse";
import { http, passthrough } from "msw";

import { signToken } from "@/auth/token";
import { router } from "@/router";
import { graphql, runGql } from "#test/gql";

import { useMswServer } from "../../../test/msw";

const msw = useMswServer();

let baseUrl: string;

beforeAll(async () => {
  await router.ready();
  baseUrl = await router.listen({ port: 0, host: "127.0.0.1" });
  // The SSE client fetches over the loopback into our own listening server;
  // MSW would otherwise reject the request as unhandled.
  msw.use(http.all(`${baseUrl}/*`, () => passthrough()));
});

afterAll(async () => {
  await router.close();
});

const CreateLiabilityDoc = graphql(`
  mutation CreateLiability($name: String!) {
    netWorthCategoryCreate(
      input: { liability: { name: $name, type: CREDIT_CARD } }
    ) {
      id
    }
  }
`);

const UpdateSkipDoc = graphql(`
  mutation UpdateSkip($id: ID!, $skip: Boolean!) {
    netWorthCategoryUpdate(id: $id, patch: { liability: { skip: $skip } }) {
      __typename
      id
      ... on NetWorthCategoryLiability {
        skip
      }
    }
  }
`);

it("toggling NetWorthCategoryLiability.skip publishes a NetWorthEntry invalidation to subscribers", async () => {
  const sse = createClient({
    url: `${baseUrl}/graphql/stream`,
    headers: { authorization: `Bearer ${signToken({ kind: "real" })}` },
  });

  // graphql-sse flushes response headers only after `execute()` has returned
  // the resolver's `AsyncIterable`, so the `connected` callback fires after
  // the `invalidations` resolver has attached its EventEmitter listener.
  // Awaiting it before the mutation guarantees no event is lost to a race.
  let onConnected!: () => void;
  const connected = new Promise<void>((r) => {
    onConnected = r;
  });
  const iter = sse.iterate<{
    invalidations: { typename: string; id: string | null };
  }>(
    {
      query: gql`
        subscription {
          invalidations {
            typename
            id
          }
        }
      `,
    },
    { connected: () => onConnected() },
  );

  try {
    await connected;

    const { netWorthCategoryCreate } = await runGql(CreateLiabilityDoc, {
      name: "Amex",
    });
    const id = netWorthCategoryCreate.id;

    const { netWorthCategoryUpdate } = await runGql(UpdateSkipDoc, {
      id,
      skip: true,
    });
    expect(netWorthCategoryUpdate).toEqual({
      __typename: "NetWorthCategoryLiability",
      id,
      skip: true,
    });

    const next = await iter.next();
    expect(next.done).toBe(false);
    expect(next.value?.data).toEqual({
      invalidations: { typename: "NetWorthEntry", id: null },
    });
  } finally {
    await iter.return?.();
    sse.dispose();
  }
});
