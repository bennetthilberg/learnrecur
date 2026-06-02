# LearnRecur

LearnRecur is a web-first spaced repetition practice app for small academic
skills. The product contract lives in `project_description.md`; the build order
lives in `roadmap.md`.

The current code is intentionally small: a first Auth + DB spine that wires
Next.js, Clerk, Prisma, and Neon Postgres together without building the full
learning workflow yet.

## Stack In This Slice

- Next.js App Router + TypeScript
- Mantine UI
- Lexend via Google Fonts
- Clerk auth
- Prisma 7 with Neon Postgres

## Local Setup

Install dependencies:

```bash
npm install
```

Copy `.env.example` to `.env.local`, then fill in the Clerk and Neon values listed
in `human-stuff.md`.

Generate the Prisma client:

```bash
npm run prisma:generate
```

Run the initial migration against the Neon development branch:

```bash
npm run prisma:migrate -- --name init_auth_db
```

Start development:

```bash
npm run dev
```

Then open `http://localhost:3000`.

## Verification

```bash
npm run lint
npm run test
npm run build
npm run prisma:validate
npm run prisma:generate
```

Database integration tests are intentionally opt-in because they write to the
configured Neon database:

```bash
npm run test:db
```

End-to-end auth-gate smoke tests run with Playwright:

```bash
npm run test:e2e
```

## Human Setup

See `human-stuff.md` for the external account/API-key setup checklist. Those
instructions are currently focused on Clerk and Neon only.
