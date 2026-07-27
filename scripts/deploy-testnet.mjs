import crypto from "node:crypto";
import fs from "node:fs";
import { Account, Address, Asset, BASE_FEE, Contract, Keypair, Networks, Operation, TransactionBuilder, nativeToScVal, rpc, scValToNative } from "@stellar/stellar-sdk";

const secret = process.env.STELLAR_SECRET;
if (!secret) throw new Error("STELLAR_SECRET is required");
const keypair = Keypair.fromSecret(secret.trim());
const networkPassphrase = Networks.TESTNET;
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const deployment = { network: "testnet", admin: keypair.publicKey(), nativeAsset: Asset.native().contractId(networkPassphrase) };

async function submit(operation) {
  const source = await server.getAccount(keypair.publicKey());
  const raw = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase }).addOperation(operation).setTimeout(300).build();
  const simulation = await server.simulateTransaction(raw);
  if (rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error);
  const prepared = rpc.assembleTransaction(raw, simulation).build(); prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared); if (sent.status === "ERROR") throw new Error(JSON.stringify(sent));
  for (let attempt = 0; attempt < 30; attempt += 1) { const result = await server.getTransaction(sent.hash); if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash: sent.hash, result }; if (result.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(JSON.stringify(result)); await new Promise((resolve) => setTimeout(resolve, 2000)); }
  throw new Error(`Timed out waiting for ${sent.hash}`);
}
async function deploy(name, file, salt) { const wasm = fs.readFileSync(file); const wasmHash = crypto.createHash("sha256").update(wasm).digest(); try { await server.getContractWasmByHash(wasmHash); } catch { await submit(Operation.uploadContractWasm({ wasm })); } const tx = await submit(Operation.createCustomContract({ address: Address.fromString(keypair.publicKey()), wasmHash, salt: Buffer.alloc(32, salt) })); const contractId = String(scValToNative(tx.result.returnValue)); deployment[name] = { contractId, deployTxHash: tx.hash, wasmHash: wasmHash.toString("hex") }; return contractId; }
async function invoke(contractId, method, args = []) { return submit(new Contract(contractId).call(method, ...args)); }
const reputationId = await deploy("reputation", new URL("../artifacts/reputation.wasm", import.meta.url), 21);
const escrowId = await deploy("bountyEscrow", new URL("../artifacts/bounty_escrow.wasm", import.meta.url), 22);
const reputationInit = await invoke(reputationId, "initialize", [nativeToScVal(escrowId, { type: "address" })]);
const escrowInit = await invoke(escrowId, "initialize", [nativeToScVal(reputationId, { type: "address" }), nativeToScVal(deployment.nativeAsset, { type: "address" })]);
const latest = await server.getLatestLedger();
const demoBounty = await invoke(escrowId, "create_bounty", [nativeToScVal(keypair.publicKey(), { type: "address" }), nativeToScVal("Soroban event dashboard", { type: "string" }), nativeToScVal("Build a polished dashboard that turns contract events into a useful builder feed.", { type: "string" }), nativeToScVal(1_000_000, { type: "i128" }), nativeToScVal(BigInt(latest.sequence + 100_000), { type: "u64" })]);
deployment.initialization = { reputationInitTxHash: reputationInit.hash, escrowInitTxHash: escrowInit.hash, demoBountyTxHash: demoBounty.hash };
fs.writeFileSync(new URL("../deployments.testnet.json", import.meta.url), `${JSON.stringify(deployment, null, 2)}\n`);
console.log(JSON.stringify(deployment, null, 2));
