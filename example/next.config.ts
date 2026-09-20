import type { NextConfig } from "next";

// The example has its own lockfile inside the library's repository.
const config: NextConfig = { outputFileTracingRoot: import.meta.dirname };

export default config;
