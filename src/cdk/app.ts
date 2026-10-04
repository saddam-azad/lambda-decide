import { App, Stack, type Environment, type StackProps } from "aws-cdk-lib";

/** Account/region from the CDK CLI (your current AWS credentials), omitting what isn't known. */
function cliEnvironment(): Environment {
  const account = process.env["CDK_DEFAULT_ACCOUNT"];
  const region = process.env["CDK_DEFAULT_REGION"];
  return { ...(account ? { account } : {}), ...(region ? { region } : {}) };
}

/**
 * One-file CDK apps. Put this in `decide.ts` and deploy with:
 *
 *   npx cdk deploy --app "npx tsx decide.ts"
 */
export function decideApp(stackId: string, build: (stack: Stack) => void, props: StackProps = {}): App {
  const app = new App();
  const stack = new Stack(app, stackId, { env: cliEnvironment(), ...props });
  build(stack);
  app.synth();
  return app;
}
