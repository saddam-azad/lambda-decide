import { fileURLToPath } from "node:url";
import { Annotations, CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import type { IGrantable, Grant } from "aws-cdk-lib/aws-iam";
import { Architecture, Code, Function as LambdaFunction, FunctionUrl, FunctionUrlAuthType, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { BackendConfig } from "../backends.ts";
import type { GatewayConfig } from "../handler/index.ts";

export interface DecisionGatewayProps {
  /** Where decisions are computed. Default: `{ preset: "openrouter" }`. */
  readonly backend?: BackendConfig;
  /**
   * Name or path of an SSM SecureString parameter you created yourself, holding the upstream
   * API key:
   *
   *   aws ssm put-parameter --name /lambda-decide/jev/api-key --type SecureString \
   *     --value "$YOUR_API_KEY" --profile burner --region us-east-1
   *
   * The gateway reads and decrypts it at runtime, so the key never enters the function's
   * configuration and rotates without a redeploy. Omit only if the upstream needs no key.
   */
  readonly apiKeySsmParameter?: string;
  /**
   * "iam" (default): callers must SigV4-sign requests; grant access with `gateway.grantInvoke(role)`.
   * "none": public URL. Only use behind your own auth; the construct adds a synth warning.
   */
  readonly auth?: "iam" | "none";
  /** Default 256. The gateway holds no model, so it rarely needs more. */
  readonly memorySize?: number;
  /** Per invocation, covers upstream retries. Default 30s. */
  readonly timeout?: Duration;
  /** Hard ceiling on concurrent executions, and therefore on spend. Needs spare account concurrency. */
  readonly reservedConcurrency?: number;
  /** In-memory cache per execution environment. Identical (redacted) requests skip the upstream call. */
  readonly cache?: { readonly ttlSeconds: number; readonly maxEntries?: number };
  /** "email" | "phone" | "card", or any string (case-insensitive regex source). Applied to `state` before it leaves your account. */
  readonly redact?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly logRetention?: RetentionDays;
}

/**
 * Ship the TypeScript sources as-is; nodejs24.x strips the types at cold start.
 * Same relative path from src/cdk/ (tsx) and from the published package root.
 * cdk/ is excluded: it imports aws-cdk-lib, which the Lambda runtime does not ship,
 * and nothing reachable from the handler imports it.
 */
function lambdaAssetDir(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

/**
 * A Lambda Function URL that speaks `POST /v1/systemone`, forwards to Jev (or any compatible backend),
 * and adds redaction, caching, audit logging and confidence gating on the way through.
 */
export class DecisionGateway extends Construct {
  readonly function: LambdaFunction;
  readonly functionUrl: FunctionUrl;
  /** The SSM parameter the gateway reads its upstream key from, if one was given. */
  readonly apiKeySsmParameter: string | undefined;
  /** The invoke URL, as a deploy-time token. */
  readonly url: string;

  constructor(scope: Construct, id: string, props: DecisionGatewayProps = {}) {
    super(scope, id);
    const auth = props.auth ?? "iam";
    this.apiKeySsmParameter = props.apiKeySsmParameter;

    if (!props.apiKeySsmParameter) {
      Annotations.of(this).addWarning(
        "DecisionGateway has no apiKeySsmParameter, so it has no upstream API key. Set DECIDE_API_KEY_SSM, or pass apiKeySsmParameter, unless your backend is keyless (a local Von/Laya).",
      );
    }

    const config: GatewayConfig = {
      backend: props.backend ?? { preset: "openrouter" },
      ...(props.apiKeySsmParameter ? { apiKeySsm: props.apiKeySsmParameter } : {}),
      ...(props.cache ? { cache: { ttlSeconds: props.cache.ttlSeconds, maxEntries: props.cache.maxEntries ?? 500 } } : {}),
      ...(props.redact?.length ? { redact: props.redact } : {}),
      ...(props.maxBodyBytes ? { maxBodyBytes: props.maxBodyBytes } : {}),
    };

    this.function = new LambdaFunction(this, "Function", {
      description: "lambda-decide gateway: POST /v1/systemone",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64, // pure JS proxy: Graviton is cheaper and equally fast here
      handler: "entry.handler",
      code: Code.fromAsset(lambdaAssetDir(), { exclude: ["cdk/**"] }),
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout ?? Duration.seconds(30),
      environment: { DECIDE_CONFIG: JSON.stringify(config) },
      logGroup: new LogGroup(this, "Logs", {
        retention: props.logRetention ?? RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      ...(props.reservedConcurrency === undefined ? {} : { reservedConcurrentExecutions: props.reservedConcurrency }),
    });
    if (props.apiKeySsmParameter) {
      // SSM parameter ARNs drop the leading slash: /a/b -> arn:…:parameter/a/b
      this.function.addToRolePolicy(new PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
        resources: [Stack.of(this).formatArn({
          service: "ssm",
          resource: "parameter",
          resourceName: props.apiKeySsmParameter.replace(/^\//, ""),
        })],
      }));
    }

    this.functionUrl = this.function.addFunctionUrl({
      authType: auth === "iam" ? FunctionUrlAuthType.AWS_IAM : FunctionUrlAuthType.NONE,
    });
    this.url = this.functionUrl.url;

    if (auth === "none") {
      Annotations.of(this).addWarning(
        "DecisionGateway auth is 'none': anyone with the URL can spend your upstream API quota. Put your own auth in front, and set reservedConcurrency.",
      );
    }

    // An explicit key, because CDK's default is a hash-suffixed logical id ("JevUrl575180B9")
    // that callers cannot grep for. This is what client code reads:
    //   aws cloudformation describe-stacks --stack-name <stack> \
    //     --query "Stacks[0].Outputs[?OutputKey=='GatewayUrl'].OutputValue" --output text
    new CfnOutput(this, "Url", { key: "GatewayUrl", value: this.url, description: "POST {state, questions} here" });
  }

  /** Allow a role / function to call the URL (auth: "iam"). */
  grantInvoke(grantee: IGrantable): Grant {
    return this.function.grantInvokeUrl(grantee);
  }
}
