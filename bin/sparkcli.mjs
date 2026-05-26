#!/usr/bin/env node
// sparkcli entry point.
//
// Uses tsx's programmatic ESM loader so we can ship TypeScript source
// without a build step. `tsImport` is hoist-safe and works across the
// Node 18+ range (avoids the deprecated --loader path).
import { tsImport } from "tsx/esm/api";
await tsImport("../src/cli.tsx", import.meta.url);
