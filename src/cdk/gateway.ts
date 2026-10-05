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
   *
   * Granted `ssm:GetParameter` on that one parameter. Encrypting with your own KMS key
   * (`--key-id`) also needs `kms:Decrypt` on that key; the construct cannot see it, so grant
   * it yourself — the default `aws/ssm` key needs nothing extra.
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
  /**
   * Per-attempt deadline for the upstream call, in ms. Default: 80% of `timeout` divided by
   * the attempt count, so 8000 on the default 30s invocation.
   *
   * Must satisfy `timeoutMs * attempts < timeout`, where attempts is the retry count plus one
   * (3 today). Enforced at synth: a gateway that cannot outlast its own retries surfaces as an
   * opaque failure instead of a `timeout` the caller can act on. `retry-after` sleeps are on
   * top of this budget — the upstream, not this number, decides how long those are.
   */
  readonly timeoutMs?: number;
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

/** Extra attempts the client makes upstream; mirrors systemOne()'s default, which the config does not carry. */
const UPSTREAM_RETRIES = 2;

const ATTEMPTS = UPSTREAM_RETRIES + 1;

/**
 * Per-attempt upstream deadline when the caller sets none. 80% of the invocation divided by
 * the attempt count: 8s on the default 30s timeout, which leaves the rest of the invocation
 * for cold start, the SSM read and the backoff sleeps between attempts.
 */
const defaultTimeoutMs = (invocationMs: number): number => Math.floor((invocationMs * 0.8) / ATTEMPTS);

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

    // The worst case is every attempt timing out, and it has to finish before the function
    // does, or the caller gets a bare Lambda timeout instead of the gateway's own 504.
    const timeout = props.timeout ?? Duration.seconds(30);
    const invocationMs = timeout.toMilliseconds();
    const timeoutMs = props.timeoutMs ?? defaultTimeoutMs(invocationMs);
    const budgetMs = timeoutMs * ATTEMPTS;
    if (!(timeoutMs > 0)) {
      throw new Error(`DecisionGateway: timeoutMs must be a positive number of milliseconds, got ${props.timeoutMs}`);
    }
    if (budgetMs >= invocationMs) {
      throw new Error(
        `DecisionGateway: timeoutMs ${timeoutMs} x ${ATTEMPTS} upstream attempts (${UPSTREAM_RETRIES} retries) = ` +
          `${budgetMs}ms, which is not below the ${invocationMs}ms function timeout. ` +
          `Lower timeoutMs (max ${Math.floor((invocationMs - 1) / ATTEMPTS)}ms here) or raise timeout.`,
      );
    }

    const config: GatewayConfig = {
      backend: props.backend ?? { preset: "openrouter" },
      ...(props.apiKeySsmParameter ? { apiKeySsm: props.apiKeySsmParameter } : {}),
      ...(props.cache ? { cache: { ttlSeconds: props.cache.ttlSeconds, maxEntries: props.cache.maxEntries ?? 500 } } : {}),
      ...(props.redact?.length ? { redact: props.redact } : {}),
      ...(props.maxBodyBytes ? { maxBodyBytes: props.maxBodyBytes } : {}),
      timeoutMs,
    };

    this.function = new LambdaFunction(this, "Function", {
      description: "lambda-decide gateway: POST /v1/systemone",
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64, // pure JS proxy: Graviton is cheaper and equally fast here
      handler: "entry.handler",
      code: Code.fromAsset(lambdaAssetDir(), { exclude: ["cdk/**"] }),
      memorySize: props.memorySize ?? 256,
      timeout,
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
        // GetParameter is the only call the handler makes. WithDecryption needs no extra action
        // for the default aws/ssm key, but a customer-managed one also needs kms:Decrypt on it,
        // which this construct cannot know about — grant that yourself.
        actions: ["ssm:GetParameter"],
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
