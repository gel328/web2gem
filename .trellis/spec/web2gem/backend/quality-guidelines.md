# Quality Guidelines

## TypeScript Baseline

The package uses strict TypeScript with:

- `strict`
- `exactOptionalPropertyTypes`
- `noImplicitReturns`
- `noUncheckedIndexedAccess`
- `noUnusedLocals`
- `noUnusedParameters`
- `isolatedModules`

Run `pnpm typecheck` from `/workspace` after code changes.

## Replacing `any`

The codebase currently has legacy `any` in provider-payload paths. Reduce it incrementally and preserve runtime compatibility with loose external JSON shapes.

Use these defaults:

- Prefer `unknown` at external boundaries.
- Narrow with `typeof`, `Array.isArray`, `isRecord`, or a local type guard before field access.
- Use `UnknownRecord` for JSON object-like payloads.
- Avoid broad exported aliases that hide unvalidated provider shapes. Do not reintroduce generic dynamic-record helpers for provider payloads; keep the loose shape local and narrow fields at the read site.

Good existing helpers:

- `src/shared/types.ts` exposes `UnknownRecord` and `isRecord`.
- `src/shared/json.ts` exposes `tryParseJson`, `parseJson`, and `parseJsonObject`.

## Change Size

When reducing `any`, prefer small, behavior-preserving batches by module. Validate each batch with `pnpm typecheck` and `pnpm check:arch`.

Avoid combining type tightening with protocol behavior changes unless the task explicitly requires both.
