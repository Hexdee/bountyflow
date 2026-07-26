import crypto from "node:crypto";
import fs from "node:fs";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

const secret = process.env.STELLAR_SECRET;
if (!secret) throw new Error("STELLAR_SECRET is required");
const keypair = Keypair.fromSecret(secret.trim());
const networkPassphrase = Networks.TESTNET;
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const deployment = {};

async function submit(operation) {
  const source = await server.getAccount(keypair.publicKey());
  const raw = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(operation)
    .setTimeout(300)
    .build();
  const simulation = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error);
  const prepared = rpc.assembleTransaction(raw, simulation).build();
  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(JSON.stringify(sent));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash: sent.hash, result };
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(JSON.stringify(result));
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${sent.hash}`);
}

async function deploy(name, wasmPath, saltByte) {
  const wasm = fs.readFileSync(wasmPath);
  const wasmHash = crypto.createHash("sha256").update(wasm).digest();
  try { await server.getContractWasmByHash(wasmHash); }
  catch { console.log(`Uploading ${name} WASM…`); await submit(Operation.uploadContractWasm({ wasm })); }
  console.log(`Deploying ${name}…`);
  const tx = await submit(Operation.createCustomContract({ address: Address.fromString(keypair.publicKey()), wasmHash, salt: Buffer.alloc(32, saltByte) }));
  const rawId = scValToNative(tx.result.returnValue);
  const contractId = typeof rawId === "string" ? rawId : rawId.toString();
  deployment[name] = { contractId, deployTxHash: tx.hash, wasmHash: wasmHash.toString("hex") };
  return contractId;
}

async function invoke(contractId, method, args = []) {
  const operation = new Contract(contractId).call(method, ...args);
  return submit(operation);
}

const registryId = await deploy("badgeRegistry", new URL("../artifacts/badge_registry.wasm", import.meta.url), 11);
const streakId = await deploy("builderStreak", new URL("../artifacts/builder_streak.wasm", import.meta.url), 12);
const registryInit = await invoke(registryId, "initialize", [nativeToScVal(streakId, { type: "address" })]);
const streakInit = await invoke(streakId, "initialize", [nativeToScVal(registryId, { type: "address" })]);
const firstActivity = await invoke(streakId, "increment", [nativeToScVal(keypair.publicKey(), { type: "address" })]);

deployment.admin = keypair.publicKey();
deployment.initialization = { registryInitTxHash: registryInit.hash, streakInitTxHash: streakInit.hash, firstActivityTxHash: firstActivity.hash };
fs.writeFileSync(new URL("../deployments.testnet.json", import.meta.url), `${JSON.stringify(deployment, null, 2)}\n`);
console.log(JSON.stringify(deployment, null, 2));
