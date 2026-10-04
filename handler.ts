import { decideApp, DecisionGateway } from "./src/cdk/index.ts";
import { apiKeySsmFromEnv, backendFromEnv, loadDotEnv } from "./src/cdk/env.ts";

// npx cdk deploy --app "npx tsx handler.ts" --profile burner
loadDotEnv();

const apiKeySsm = apiKeySsmFromEnv();

decideApp("DecisionGateway", (stack) => {
  new DecisionGateway(stack, "Jev", {
    backend: backendFromEnv(),                  // DECIDE_BACKEND, or DECIDE_BACKEND_URL + DECIDE_MODEL
    ...(apiKeySsm ? { apiKeySsmParameter: apiKeySsm } : {}), // a pointer to the key, never the key
    redact: ["email", "card"],                  // scrubbed before state leaves your account
    cache: { ttlSeconds: 300 },                 // identical requests skip the upstream call
    // reservedConcurrency: 20,                 // hard spend ceiling (needs spare account concurrency)
  });
});
