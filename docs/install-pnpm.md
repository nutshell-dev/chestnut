# Installing pnpm

Chestnut pins [pnpm](https://pnpm.io) to **10.28.1** in the `packageManager` field of `package.json`. Use the same version when installing dependencies or updating `pnpm-lock.yaml`.

## Corepack (recommended)

Enable Corepack in the repository, then let it select the pinned version:

```bash
corepack enable
cd /path/to/chestnut
pnpm --version
```

The version command should print `10.28.1`. Corepack downloads the pinned pnpm release automatically on first use.

Install dependencies with the lockfile enforced:

```bash
pnpm install --frozen-lockfile
```

## Alternative: global npm installation

If Corepack is unavailable, install the same exact version globally:

```bash
npm install -g pnpm@10.28.1
pnpm --version
```

Do not use a different pnpm major version to regenerate the lockfile. For more installation options, see the [official pnpm installation docs](https://pnpm.io/installation).
