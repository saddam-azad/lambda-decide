// Lambda entrypoint shim. Not generated — committed, and the reason there is no build step.
// Lambda's handler loader only resolves .js/.mjs/.cjs, but the nodejs24.x runtime is Node 24,
// which strips types from .ts natively. This one-liner bridges the two.
export const handler = (event, context) => import("./handler/index.ts").then((m) => m.handler(event, context));
