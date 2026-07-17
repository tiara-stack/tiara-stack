#!/usr/bin/env node

import "tsx/esm";

const { runMain } = await import("../src/cli/index.ts");

runMain();
