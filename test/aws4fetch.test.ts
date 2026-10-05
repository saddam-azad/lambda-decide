import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AwsClient } from "aws4fetch";
import { backends, decide, DecideError, score } from "../src/index.ts";
import { JEV_MUDDY_TICKET } from "./helpers.ts";

const questions = {
  severity: score("How severe?", ["cosmetic", "workaround exists", "blocking"]),
};

interface Seen { readonly method: string | undefined; readonly url: string | undefined; readonly headers: IncomingHttpHeaders }

/** Stands in for the Function URL: records what arrives, answers with a real /v1/systemone body. */
async function gateway(onRequest: (seen: Seen) => void): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    onRequest({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(JEV_MUDDY_TICKET));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

test("the README's SigV4 snippet signs a call to backends.gateway and gets a decision back", async (t) => {
  const seen: Seen[] = [];
  const { url, server } = await gateway((s) => seen.push(s));
  t.after(() => server.close());

  // aws4fetch exports AwsClient, not a callable default: credentials and region are both
  // constructor arguments, and there is no provider chain to fall back on.
  const aws = new AwsClient({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    sessionToken: "session-token-from-a-profile",
    region: "eu-north-1",
    service: "lambda",
  });

  const d = decide({ backend: backends.gateway(url, { fetch: aws.fetch.bind(aws) }) });
  const r = await d.ask("two charges", questions);

  assert.equal(r.answers.severity.score, 1.15);
  assert.equal(seen.length, 1);

  // The signature names the region and service we passed. Left out, aws4fetch guesses from the
  // host and falls back to us-east-1, which is a 403 for a gateway in any other region.
  const auth = seen[0]!.headers["authorization"]!;
  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-north-1\/lambda\/aws4_request,/);
  assert.match(auth, /SignedHeaders=[a-z0-9;-]*host/);
  assert.equal(seen[0]!.headers["x-amz-date"]?.length, 16); // 20261005T101112Z
  assert.equal(seen[0]!.headers["x-amz-security-token"], "session-token-from-a-profile");
  assert.equal(seen[0]!.headers["content-type"], "application/json", "unsigned, but sent");
  assert.equal(seen[0]!.url, "/v1/systemone");

  // The signature lands in the very header a client would otherwise spend on a bearer token,
  // which is why backends.gateway() refuses to send an apiKey of its own.
  assert.doesNotMatch(auth, /Bearer|session-token-from-a-profile/);
});

test("an unbound AwsClient.fetch is a network error, so the snippet binds it", async () => {
  // The library calls fetch(url, init) as a plain function, which detaches `this`: unbound, the
  // client throws inside its own retry loop and reports the typo as an upstream outage.
  const aws = new AwsClient({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "s", region: "eu-north-1", service: "lambda" });
  const unbound = decide({ backend: backends.gateway("https://g.test", { fetch: aws.fetch }) });

  await assert.rejects(
    unbound.ask("two charges", questions),
    (e: unknown) => e instanceof DecideError && e.code === "network",
  );
});

test("there is no callable default export, and credentials are not optional", async () => {
  const mod = await import("aws4fetch");
  assert.equal((mod as unknown as { default?: unknown }).default, undefined);
  // The types already forbid this; the runtime enforces it too, with a TypeError naming the option.
  // @ts-expect-error accessKeyId and secretAccessKey are required
  assert.throws(() => new AwsClient({ service: "lambda" }), /accessKeyId is a required option/);
  // @ts-expect-error secretAccessKey is required
  assert.throws(() => new AwsClient({ accessKeyId: "AKIDEXAMPLE" }), /secretAccessKey is a required option/);
});