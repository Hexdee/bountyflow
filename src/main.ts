import "./style.css";
import { getNetworkDetails, isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";
import { Account, BASE_FEE, Contract, Horizon, Networks, nativeToScVal, rpc, scValToNative, TransactionBuilder } from "@stellar/stellar-sdk";
import { badgeName, formatError, shortAddress } from "./lib/format";

const STREAK_ID = import.meta.env.VITE_STREAK_CONTRACT_ID || import.meta.env.VITE_CONTRACT_ID || "REPLACE_WITH_STREAK_CONTRACT_ID";
const REGISTRY_ID = import.meta.env.VITE_REGISTRY_CONTRACT_ID || "REPLACE_WITH_REGISTRY_CONTRACT_ID";
const RPC_URL = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

const rpcServer = new rpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);
let walletAddress = "";
let lastEventIds = new Set<string>();
let syncTimer: number | undefined;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="app-shell">
    <header class="topbar"><div class="brand">RISE IN · ORANGE BELT</div><div class="network-pill">● Stellar Testnet</div></header>
    <section class="hero">
      <div class="eyebrow">BUILDER STREAK · EVENT-DRIVEN DAPP</div>
      <h1>Ship activity.<br />Earn your badge.</h1>
      <p class="hero-copy">A production-shaped Soroban dApp for builders. Every authenticated activity is recorded by one contract, forwarded to a second registry, and surfaced here through live on-chain events.</p>
    </section>
    <section class="grid">
      <div>
        <article class="card card-pad">
          <div class="section-heading"><div><h2>Your builder profile</h2><div class="muted">Connect Freighter before accessing Testnet data.</div></div><button id="connect" class="button secondary">Connect wallet</button></div>
          <div class="wallet-row"><span id="wallet" class="wallet-address">Wallet connection required</span><button id="increment" class="button" disabled>Log activity</button></div>
          <p id="status" class="status" aria-live="polite">Connect Freighter to load your on-chain profile.</p>
          <a id="tx" class="tx-link hidden" target="_blank" rel="noreferrer"></a>
        </article>
        <article class="card card-pad action-card">
          <div class="section-heading"><div><h2>Live activity stream</h2><div class="muted">Polling Soroban RPC every 8 seconds.</div></div><span id="sync" class="muted">Syncing…</span></div>
          <div id="events" class="event-list"><div class="empty">Waiting for Builder Streak events…</div></div>
        </article>
      </div>
      <aside>
        <article class="card card-pad">
          <div class="eyebrow">CURRENT STREAK</div>
          <div id="count" class="streak-number">—</div>
          <div class="streak-label">verified builder activities</div>
          <div class="progress"><span id="progress"></span></div>
          <div class="stat-line"><span>Next badge</span><strong id="badge">Loading…</strong></div>
          <div class="stat-line"><span>Network total</span><strong id="total">—</strong></div>
        </article>
        <article class="card card-pad action-card">
          <div class="eyebrow">CONTRACT TOPOLOGY</div>
          <p class="muted">Builder Streak → Badge Registry</p>
          <div class="stat-line"><span>Streak</span><a href="https://stellar.expert/explorer/testnet/contract/${STREAK_ID}" target="_blank" rel="noreferrer">${shortAddress(STREAK_ID)} ↗</a></div>
          <div class="stat-line"><span>Registry</span><a href="https://stellar.expert/explorer/testnet/contract/${REGISTRY_ID}" target="_blank" rel="noreferrer">${shortAddress(REGISTRY_ID)} ↗</a></div>
        </article>
      </aside>
    </section>
    <footer class="footer"><span>Orange Belt submission · production architecture practice</span><a href="https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup" target="_blank" rel="noreferrer">Stellar docs ↗</a></footer>
  </div>
`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const connectButton = $("#connect");
const incrementButton = $("#increment");
const statusEl = $("#status");
const txEl = $("#tx");

function setStatus(message: string, kind = "") { statusEl.textContent = message; statusEl.className = `status ${kind}`; }
function activeAddress() {
  if (!walletAddress) throw new Error("Connect Freighter before loading your profile.");
  return walletAddress;
}

async function loadWalletAccount() {
  try {
    return await horizon.loadAccount(activeAddress());
  } catch (error) {
    const message = formatError(error);
    if (/not found|404/i.test(message)) {
      throw new Error("This Freighter account is not funded on Stellar Testnet. Fund it with Friendbot, then connect again.");
    }
    throw error;
  }
}
function ensureConfigured() {
  if (STREAK_ID.startsWith("REPLACE") || REGISTRY_ID.startsWith("REPLACE")) throw new Error("Testnet contract addresses are not configured yet.");
}

async function simulateCall(contractId: string, method: string, args: unknown[], types: string[]) {
  const source = await loadWalletAccount();
  const account = new Account(source.accountId(), source.sequence);
  const operation = new Contract(contractId).call(...[method, ...args.map((arg, index) => nativeToScVal(arg, { type: types[index] }))]);
  const transaction = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE }).addOperation(operation).setTimeout(30).build();
  const simulation = await rpcServer.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error);
  if (!simulation.result) throw new Error("RPC returned no contract result.");
  return scValToNative(simulation.result.retval);
}

async function refreshProfile() {
  ensureConfigured();
  const [count, total, badge] = await Promise.all([
    simulateCall(STREAK_ID, "get_count", [activeAddress()], ["address"]),
    simulateCall(STREAK_ID, "get_total", [], []),
    simulateCall(REGISTRY_ID, "get_badge", [activeAddress()], ["address"]),
  ]);
  const countNumber = Number(count);
  $("#count").textContent = String(countNumber);
  $("#total").textContent = String(total);
  $("#badge").textContent = badgeName(Number(badge));
  $("#progress").setAttribute("style", `width:${Math.min(100, (countNumber % 3) * 33.333 + (countNumber > 0 && countNumber % 3 === 0 ? 100 : 0))}%`);
  if (!walletAddress) setStatus("Profile synced from Stellar Testnet.", "success");
}

async function refreshEvents() {
  const latest = await rpcServer.getLatestLedger();
  const response = await rpcServer.getEvents({ startLedger: Math.max(1, latest.sequence - 500), filters: [{ type: "contract", contractIds: [STREAK_ID, REGISTRY_ID] }], limit: 20 });
  const events = response.events.filter((event) => !lastEventIds.has(event.id)).reverse();
  events.forEach((event) => lastEventIds.add(event.id));
  const container = $("#events");
  if (events.length === 0 && lastEventIds.size === 0) { container.innerHTML = `<div class="empty">No recent events yet. Log the first activity.</div>`; }
  if (events.length > 0) {
    container.querySelector(".empty")?.remove();
    const html = events.map((event) => {
      const kind = String(scValToNative(event.topic[0]));
      const value = String(scValToNative(event.value));
      const builder = event.topic[1] ? String(scValToNative(event.topic[1])) : "builder";
      return `<div class="event-row"><div class="event-icon">✦</div><div class="event-copy"><div class="event-title"><strong>${kind === "badge" ? "Badge Registry updated" : "Builder activity recorded"}</strong> · ${shortAddress(builder)}</div><div class="event-time">Level ${value} · ledger ${event.ledger} · <a href="https://stellar.expert/explorer/testnet/tx/${event.txHash}" target="_blank" rel="noreferrer">view transaction ↗</a></div></div></div>`;
    }).join("");
    container.insertAdjacentHTML("afterbegin", html);
  }
  $("#sync").textContent = `Synced ledger ${latest.sequence}`;
}

connectButton.addEventListener("click", async () => {
  try {
    const connection = await isConnected();
    if (!connection.isConnected) throw new Error("Freighter was not detected. Open the Freighter extension and reload this page.");
    const access = await requestAccess();
    if (access.error) throw new Error(typeof access.error === "string" ? access.error : access.error.message);
    const network = await getNetworkDetails();
    if (network.error) throw new Error(typeof network.error === "string" ? network.error : network.error.message);
    if (network.network !== "TESTNET") throw new Error("Switch Freighter to Stellar Testnet, then connect again.");
    walletAddress = access.address;
    $("#wallet").textContent = walletAddress;
    connectButton.textContent = "Wallet connected";
    setStatus("Wallet connected. You can now log a builder activity.", "success");
    await refreshProfile();
    await refreshEvents();
    incrementButton.removeAttribute("disabled");
    if (syncTimer === undefined) syncTimer = window.setInterval(() => { void refresh(); }, 8000);
  } catch (error) {
    walletAddress = "";
    $("#wallet").textContent = "Wallet connection required";
    connectButton.textContent = "Connect wallet";
    incrementButton.setAttribute("disabled", "true");
    setStatus(formatError(error), "error");
  }
});

incrementButton.addEventListener("click", async () => {
  try {
    if (!walletAddress) throw new Error("Connect Freighter first.");
    incrementButton.setAttribute("disabled", "true");
    setStatus("Simulating the cross-contract activity call…");
    const source = await loadWalletAccount();
    const account = new Account(source.accountId(), source.sequence);
    const operation = new Contract(STREAK_ID).call("increment", nativeToScVal(walletAddress, { type: "address" }));
    const raw = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE }).addOperation(operation).setTimeout(60).build();
    const simulation = await rpcServer.simulateTransaction(raw);
    if (rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error);
    const prepared = rpc.assembleTransaction(raw, simulation).build();
    const signed = await signTransaction(prepared.toXDR(), { networkPassphrase: NETWORK_PASSPHRASE, address: walletAddress });
    if (signed.error) throw new Error(typeof signed.error === "string" ? signed.error : signed.error.message);
    const sent = await rpcServer.sendTransaction(TransactionBuilder.fromXDR(signed.signedTxXdr, NETWORK_PASSPHRASE));
    if (sent.status === "ERROR") throw new Error("The network rejected the transaction.");
    setStatus("Transaction submitted. Waiting for confirmation…");
    txEl.textContent = `Transaction: ${sent.hash}`;
    txEl.setAttribute("href", `https://stellar.expert/explorer/testnet/tx/${sent.hash}`);
    txEl.classList.remove("hidden");
    await refreshProfile();
    await refreshEvents();
    setStatus("Activity recorded and forwarded to the Badge Registry.", "success");
  } catch (error) { setStatus(formatError(error), "error"); }
  finally { incrementButton.removeAttribute("disabled"); }
});

async function refresh() {
  try { await Promise.all([refreshProfile(), refreshEvents()]); }
  catch (error) { setStatus(formatError(error), "error"); }
}
void isConnected().then((connection) => {
  if (connection.isConnected) setStatus("Freighter detected. Connect to continue.", "success");
}).catch(() => undefined);
