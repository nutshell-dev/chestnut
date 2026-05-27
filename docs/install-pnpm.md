# Installing pnpm

[pnpm](https://pnpm.io) is a fast, disk-efficient package manager required by Clawforum.

## Option 1: via npm (recommended)

```bash
npm install -g pnpm
```

## Option 2: via install script

**macOS / Linux**

```bash
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

**Windows (PowerShell)**

```powershell
iwr https://get.pnpm.io/install.ps1 -useb | iex
```

## Option 3: via Homebrew (macOS)

```bash
brew install pnpm
```

## Verify installation

```bash
pnpm --version
```

For more options, see the [official pnpm installation docs](https://pnpm.io/installation).
