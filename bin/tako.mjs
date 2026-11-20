#!/usr/bin/env node
// The hub is TypeScript source, like the rest of this package: tsx runs it.
import { register } from "tsx/esm/api";
register();
await import("../src/hub/main.ts");
