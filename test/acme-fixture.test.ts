import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { webcrypto, X509Certificate, createPrivateKey, randomUUID } from "node:crypto";
import { Pkcs10CertificateRequest, X509CertificateGenerator, SubjectAlternativeNameExtension } from "@peculiar/x509";
import * as acme from "acme-client";
import { issueBrowserCertificate } from "../src/browser-https.js";

test("real ACME client completes HTTP-01 and finalizes its CSR against a local CA", { timeout: 10000 }, async () => {
  const challenges = new Map<string, string>(), requests: string[] = [], domain = "127.0.0.1";
  let challengeValid = false, certificate = "", origin = "";
  const authority = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const authorization = () => ({ identifier: { type: "dns", value: domain }, status: challengeValid ? "valid" : "pending",
    challenges: [{ type: "http-01", token: "local_test_token", url: `${origin}/challenge`, status: challengeValid ? "valid" : "pending" }] });
  const order = () => ({ status: certificate ? "valid" : "ready", identifiers: [{ type: "dns", value: domain }],
    authorizations: [`${origin}/authorization`], finalize: `${origin}/finalize`, ...(certificate ? { certificate: `${origin}/certificate` } : {}) });
  const server = createServer((req, res) => {
    void (async () => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("Replay-Nonce", randomUUID()); res.setHeader("Content-Type", "application/json");
      if (req.url?.startsWith("/.well-known/acme-challenge/")) {
        res.setHeader("Content-Type", "text/plain"); const token = req.url.split("/").at(-1)!;
        res.end(challenges.get(token) ?? "missing"); return;
      }
      if (req.url === "/directory") { res.end(JSON.stringify({ newNonce: `${origin}/nonce`, newAccount: `${origin}/account`, newOrder: `${origin}/order` })); return; }
      if (req.method === "HEAD") { res.end(); return; }
      let encoded = ""; for await (const chunk of req) encoded += chunk;
      const jws = JSON.parse(encoded), body = jws.payload ? JSON.parse(Buffer.from(jws.payload, "base64url").toString()) : {};
      if (req.url === "/account") { assert.equal(body.termsOfServiceAgreed, true); assert.deepEqual(body.contact, ["mailto:owner@example.com"]); res.statusCode = 201; res.setHeader("Location", `${origin}/account/1`); res.end(JSON.stringify({ status: "valid" })); }
      else if (req.url === "/order") { res.statusCode = 201; res.setHeader("Location", `${origin}/order/1`); res.end(JSON.stringify(order())); }
      else if (req.url === "/authorization") res.end(JSON.stringify(authorization()));
      else if (req.url === "/challenge") {
        assert.match(challenges.get("local_test_token") ?? "", /^local_test_token\.[A-Za-z0-9_-]+$/);
        challengeValid = true; res.end(JSON.stringify(authorization().challenges[0]));
      } else if (req.url === "/finalize") {
        assert.equal(challengeValid, true);
        const csr = new Pkcs10CertificateRequest(Buffer.from(body.csr, "base64url"));
        const issued = await X509CertificateGenerator.create({ subject: csr.subject, issuer: "CN=Local test CA", publicKey: csr.publicKey,
          signingKey: authority.privateKey as CryptoKey, signingAlgorithm: { name: "ECDSA", hash: "SHA-256" }, serialNumber: "01",
          notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 90 * 86400_000),
          extensions: [new SubjectAlternativeNameExtension([{ type: "ip", value: domain }])] });
        certificate = issued.toString("pem"); res.end(JSON.stringify(order()));
      } else if (req.url === "/order/1") res.end(JSON.stringify(order()));
      else if (req.url === "/certificate") { res.setHeader("Content-Type", "application/pem-certificate-chain"); res.end(certificate); }
      else { res.statusCode = 404; res.end("{}"); }
    })().catch(error => { res.statusCode = 500; res.end(JSON.stringify({ detail: String(error) })); });
  });
  await new Promise<void>(resolve => server.listen(0, domain, resolve));
  const port = (server.address() as import("node:net").AddressInfo).port; origin = `http://${domain}:${port}`;
  const settings = (acme.axios.defaults as typeof acme.axios.defaults & { acmeSettings: { httpChallengePort: number } }).acmeSettings;
  const previousPort = settings.httpChallengePort; settings.httpChallengePort = port;
  try {
    const pair = await issueBrowserCertificate({ domain, accountKey: (await acme.crypto.createPrivateEcdsaKey()).toString(), email: "owner@example.com",
      signal: new AbortController().signal, challenges, directoryUrl: `${origin}/directory` });
    const leaf = new X509Certificate(pair.cert); assert.ok(leaf.checkPrivateKey(createPrivateKey(pair.key))); assert.equal(leaf.issuer, "CN=Local test CA");
    assert.ok(requests.some(value => value.includes("/.well-known/acme-challenge/")), "the library actually verifies the exposed challenge over HTTP");
    assert.ok(requests.includes("POST /challenge") && requests.includes("POST /finalize") && requests.includes("POST /certificate"));
    assert.equal(challenges.size, 0);
  } finally { settings.httpChallengePort = previousPort; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
