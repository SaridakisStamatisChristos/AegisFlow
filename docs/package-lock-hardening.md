# Dependency-lock reproducibility hardening

This change closes the dependency-resolution caveat carried through PR8.

## Contract

- Generate the root npm workspace `package-lock.json` with npm `10.9.2`, matching the root `packageManager` declaration.
- Commit the lockfile.
- CI must install with `npm ci --ignore-scripts`; it must not fall back to `npm install`.
- Lockfile generation must not mutate root or workspace `package.json` files.
- The committed lockfile must be included in the executable/config artifact closure.
- The full source, PostgreSQL, boundary, secret-scan, manifest, and runtime-audit gates must remain green.

## Scope boundary

This hardening changes dependency reproducibility only. It does not introduce PR9 Control API/SDK behavior or modify runtime semantics.
