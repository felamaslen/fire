# fire

A personal net-worth tracker. Records assets, investments, and month-by-month cashflow planning in one place, and answers the only question that really matters: am I on track.

## Packages

- [`packages/backend`](./packages/backend) — Fastify + Apollo GraphQL server on Postgres 18 (Drizzle ORM). Schema is hand-written with [Grats](https://grats.capt.dev/) JSDoc tags.
- [`packages/web`](./packages/web) — React 19 + TanStack Router single-page app. Apollo Client, `gql.tada` for typed documents, Tailwind + Radix UI.

## Feature set

### Net worth
- Category / asset hierarchy with per-asset currency, and a roll-up of current value across categories.
- Manual valuations over time — each asset carries its own time series so the total can be rebuilt historically.

### Investments
- Stock holdings with automatic live quotes via Yahoo Finance, refreshed on a cron.
- Position tracking with transaction ledger (buys / sells), cost basis, and realised / unrealised gain.
- Stock-split handling so historical positions survive corporate actions.
- Portfolio page with:
  - Line / candlestick chart, switchable between `3m`, `YTD`, `1y`, `3y`, `5y`, `All`.
  - Stacked per-investment area mode with legend.
  - Hover tooltips on both candles (date / open / close / high / low) and line series (date + value per series, with crosshair).
- Per-investment allocation breakdown.

### Planning (cashflow)
- Month-by-month planning model: bills, earnings, payslips (with tax), and ad-hoc transactions.
- Rolling balance projection forward from a starting point.
- UK tax helpers (PAYE-style computation) baked into earnings.

### Other
- File uploads (local disk) for attaching documents to records.
- OpenTelemetry tracing across HTTP, Fastify routes, and Drizzle queries.

## Dev setup

### Prerequisites
- Node ≥ 22
- `pnpm` (repo pins a version via `packageManager`)
- Docker (for Postgres + Jaeger)

### First-time bootstrap

```bash
pnpm install
```

Start the dependent services (Postgres and Jaeger):

```bash
cd packages/backend
docker compose up -d
```

Create a `.env` in `packages/backend`:

```
DATABASE_URL=postgres://fire:fire@localhost:5433/fire
UPLOADS_DIR=./uploads
```

Apply migrations:

```bash
pnpm --filter backend db:migrate
```

### Running

Backend (`:4000`, GraphQL at `/graphql`):

```bash
pnpm --filter backend dev
```

Web app (`:4001`):

```bash
pnpm --filter web dev
```

With both running, regenerate the frontend's typed GraphQL from the backend's live schema whenever resolvers change:

```bash
pnpm --filter web download-schema
pnpm --filter web codegen
```

### Common tasks

| Task                                    | Command                                      |
| --------------------------------------- | -------------------------------------------- |
| Typecheck everything                    | `pnpm typecheck`                             |
| Backend tests (vitest)                  | `pnpm --filter backend test`                 |
| Generate a new Drizzle migration        | `pnpm --filter backend db:generate`          |
| Inspect the DB visually                 | `pnpm --filter backend db:studio`            |
| Regenerate the GraphQL schema (Grats)   | `pnpm --filter backend grats`                |
| Regenerate schema + SQL snapshot        | `pnpm --filter backend codegen`              |
| Refresh typed GraphQL docs on the web   | `pnpm --filter web codegen`                  |

## Architecture

```mermaid
flowchart LR
    Browser[Browser]
    Web[packages/web<br/>React 19 + TanStack Router<br/>Apollo Client + gql.tada]
    Backend[packages/backend<br/>Fastify + Apollo Server<br/>Grats schema]
    Drizzle[Drizzle ORM]
    PG[(Postgres 18)]
    Yahoo[Yahoo Finance]
    Cron[quote-cron<br/>node-cron]
    OTLP[OTLP/HTTP :4318]
    Jaeger[Jaeger UI :16686]

    Browser -->|HTTPS| Web
    Web -->|GraphQL over HTTP| Backend
    Backend --> Drizzle --> PG
    Cron --> Yahoo
    Cron --> Drizzle
    Backend -.spans.-> OTLP --> Jaeger
```

Key runtime flows:

- **Reads** — the web app issues one `useSuspenseQuery` per route with every child fragment spread in, so the page paints once rather than flashing a spinner per widget. Subsequent refreshes (period changes, re-sorts) use non-suspending queries and dim the previous render in place.
- **Writes** — GraphQL mutations hit Fastify, which delegates to Apollo; resolvers call Drizzle, which emits spans into the same trace as the HTTP span via `@kubiks/otel-drizzle`.
- **Quotes** — `scheduleQuoteRefresh` (in `src/tasks/quote-cron.ts`) runs on a cron, pulls latest prices from Yahoo Finance, and upserts them onto the position records.

## Observability (OpenTelemetry)

The backend emits OTLP traces to a local collector. `docker-compose.yml` ships a Jaeger all-in-one so you can read them out of the box — no extra setup.

### How it's wired

- `otel.mjs` at the backend root bootstraps the `@opentelemetry/sdk-node` SDK. It's preloaded via `NODE_OPTIONS="--import=./otel.mjs"` in `pnpm dev` so the SDK starts *before* `http` or `fastify` are loaded. Do not `import` it from application code.
- `@fastify/otel` is registered as a Fastify plugin in `src/router.ts` — this produces per-request lifecycle spans (route resolution, serialisation, etc.).
- `@opentelemetry/instrumentation-http` adds the outer server span and any outbound HTTP client calls (e.g. Yahoo Finance quote fetches) as child spans of the same trace.
- `@kubiks/otel-drizzle` wraps the Drizzle client so every query becomes a span under the active HTTP span, with the SQL text + params attached.

### Environment

| Variable                      | Default                  | Notes                                                                   |
| ----------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `OTEL_ENABLED`                | `true` in `development`  | Off by default in `test` / `production`.                                |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318`  | Base URL only — `/v1/traces` is appended per signal.                    |

### Viewing traces

1. `docker compose up -d jaeger` (included in the default compose file).
2. Open <http://localhost:16686>.
3. Service: `fire-backend`.

Each GraphQL request shows up as one trace: the top span is the HTTP handler; nested under it are the Fastify lifecycle spans, the Apollo resolver work, any Drizzle queries (with SQL + params), and any outbound Yahoo Finance calls.
