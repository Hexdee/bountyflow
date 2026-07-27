import "./style.css";
import { getNetworkDetails, isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";
import { Account, BASE_FEE, Contract, Horizon, Networks, nativeToScVal, rpc, scValToNative, TransactionBuilder } from "@stellar/stellar-sdk";
import { formatError, shortAddress, stellarFromStroops } from "./lib/format";

const ESCROW_ID = import.meta.env.VITE_ESCROW_CONTRACT_ID || "REPLACE_WITH_ESCROW_CONTRACT_ID";
const REPUTATION_ID = import.meta.env.VITE_REPUTATION_CONTRACT_ID || "REPLACE_WITH_REPUTATION_CONTRACT_ID";
const RPC_URL = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK = Networks.TESTNET;
const rpcServer = new rpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);
let walletAddress = "";
let syncTimer: number | undefined;
let seenEvents = new Set<string>();
let selectedId = 0;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
<div class="app-shell">
  <header class="topbar"><a class="brand" href="#">BOUNTY<span>FLOW</span></a><nav><a href="#marketplace">Marketplace</a><a href="#how">How it works</a></nav><div class="network-pill">● Stellar Testnet</div><button id="connect" class="button secondary">Connect Freighter</button></header>
  <main>
    <section class="hero"><div class="eyebrow">OPEN WORK · VERIFIED DELIVERY · XLM ESCROW</div><h1>Fund great work.<br><em>Ship with confidence.</em></h1><p>Discover focused Web3 bounties, lock the reward in a Soroban escrow, and pay only when the work is approved.</p><div class="hero-actions"><a class="button" href="#marketplace">Explore bounties <span>↗</span></a><a class="text-link" href="#create">Post a bounty</a></div><div class="trust-row"><span>✦ Non-custodial escrow</span><span>✦ On-chain reputation</span><span>✦ Real-time activity</span></div></section>
    <section id="marketplace" class="workspace-grid"><div class="main-column">
      <div class="section-heading"><div><div class="eyebrow">LIVE MARKETPLACE</div><h2>Open opportunities</h2></div><span id="sync" class="muted">Connect wallet to sync</span></div>
      <div id="bounties" class="bounty-grid"><div class="loading-card"><span class="spinner"></span><p>Connect Freighter to load the marketplace.</p></div></div>
      <article id="detail" class="card detail-card hidden"></article>
    </div><aside class="side-column"><article class="card profile-card"><div class="section-heading"><div><div class="eyebrow">YOUR BUILDER PROFILE</div><h2 id="wallet-label">Wallet required</h2></div><span class="profile-dot">●</span></div><div class="profile-stats"><div><strong id="completions">—</strong><span>completed</span></div><div><strong id="earned">—</strong><span>XLM earned</span></div></div><p id="status" class="status">Connect Freighter before accessing Testnet data.</p></article>
      <article id="create" class="card create-card"><div class="eyebrow">FOR PROJECT OWNERS</div><h2>Post a bounty</h2><p class="muted">Fund the reward now. It stays locked until your approval.</p><form id="create-form"><label>Title<input id="title" required maxlength="48" placeholder="e.g. Build a Soroban indexer" /></label><label>Brief<textarea id="description" required maxlength="240" placeholder="Describe the outcome and acceptance criteria"></textarea></label><div class="form-row"><label>Reward (XLM)<input id="reward" required type="number" min="0.1" step="0.1" value="2" /></label><label>Due in days<input id="days" required type="number" min="1" max="90" value="14" /></label></div><button class="button full" type="submit">Fund & publish bounty <span>↗</span></button></form></article></aside></section>
    <section id="how" class="how-section"><div><div class="eyebrow">A BETTER WAY TO SHIP</div><h2>From brief to payout,<br/>every step is accountable.</h2></div><div class="steps"><div><span>01</span><h3>Fund</h3><p>Owners lock XLM in a transparent Soroban escrow.</p></div><div><span>02</span><h3>Deliver</h3><p>One builder is assigned and submits a verifiable proof link.</p></div><div><span>03</span><h3>Approve</h3><p>Approval releases funds and updates the builder’s reputation.</p></div></div></section>
    <section class="activity-section"><div class="section-heading"><div><div class="eyebrow">ON-CHAIN SIGNAL</div><h2>Live activity</h2></div><span class="muted">Soroban RPC event stream</span></div><div id="events" class="event-list"><div class="empty">Activity will appear after the first wallet connection.</div></div></section>
  </main><footer><span>BOUNTYFLOW · ORANGE BELT SUBMISSION</span><span>Built on Stellar Soroban</span></footer>
</div>`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const connectButton = $("#connect") as HTMLButtonElement;
const statusEl = $("#status");

function setStatus(message: string, kind = "") { statusEl.textContent = message; statusEl.className = `status ${kind}`; }
function configured() { return !ESCROW_ID.startsWith("REPLACE") && !REPUTATION_ID.startsWith("REPLACE"); }
function active() { if (!walletAddress) throw new Error("Connect Freighter before using BountyFlow."); return walletAddress; }
async function account() {
  try { return await horizon.loadAccount(active()); }
  catch (error) { if (/not found|404/i.test(formatError(error))) throw new Error("This wallet is not funded on Stellar Testnet. Fund it with Friendbot, then reconnect."); throw error; }
}
function argsFor(args: unknown[], types: string[]) { return args.map((arg, i) => nativeToScVal(arg, { type: types[i] })); }
async function simulate(contractId: string, method: string, args: unknown[], types: string[]) {
  const source = await account();
  const tx = new TransactionBuilder(new Account(source.accountId(), source.sequence), { fee: BASE_FEE, networkPassphrase: NETWORK }).addOperation(new Contract(contractId).call(method, ...argsFor(args, types))).setTimeout(60).build();
  const result = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(result)) throw new Error(result.error);
  if (!result.result) throw new Error("Soroban returned no contract result.");
  return scValToNative(result.result.retval) as any;
}
async function write(contractId: string, method: string, args: unknown[], types: string[]) {
  const source = await account();
  const tx = new TransactionBuilder(new Account(source.accountId(), source.sequence), { fee: BASE_FEE, networkPassphrase: NETWORK }).addOperation(new Contract(contractId).call(method, ...argsFor(args, types))).setTimeout(60).build();
  const simulated = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulated)) throw new Error(simulated.error);
  const prepared = rpc.assembleTransaction(tx, simulated).build();
  const signed = await signTransaction(prepared.toXDR(), { networkPassphrase: NETWORK, address: active() });
  if (signed.error) throw new Error(typeof signed.error === "string" ? signed.error : signed.error.message);
  const sent = await rpcServer.sendTransaction(TransactionBuilder.fromXDR(signed.signedTxXdr, NETWORK));
  if (sent.status === "ERROR") throw new Error("The network rejected this transaction.");
  return sent.hash;
}
function bountyStatus(value: any) { return typeof value === "object" && value !== null ? Object.keys(value)[0] : String(value); }
function normalized(raw: any) { return { ...raw, id: Number(raw.id), reward: BigInt(raw.reward ?? 0), deadline: Number(raw.deadline), status: bountyStatus(raw.status), builder: raw.builder ?? null, proof: raw.proof ?? null }; }
function shortText(value: string, length = 90) { return value.length > length ? `${value.slice(0, length - 1)}…` : value; }
function cardMarkup(b: any) { const mine = b.creator === walletAddress; return `<button class="bounty-card ${b.status.toLowerCase()}" data-id="${b.id}"><div class="card-top"><span class="tag ${b.status.toLowerCase()}">${b.status}</span><span class="bounty-id">#${String(b.id).padStart(3, "0")}</span></div><h3>${b.title}</h3><p>${shortText(b.description)}</p><div class="card-bottom"><span><strong>${stellarFromStroops(b.reward)} XLM</strong><small>escrowed reward</small></span><span class="owner">${mine ? "Your bounty" : shortAddress(b.creator)}</span></div></button>`; }
async function refreshBounties() { const total = Number(await simulate(ESCROW_ID, "get_total", [], [])); const list: any[] = []; for (let id = 1; id <= total; id += 1) { try { list.push(normalized(await simulate(ESCROW_ID, "get_bounty", [id], ["u64"]))); } catch { /* a cancelled or pruned id should not stop the feed */ } } $("#bounties").innerHTML = list.length ? list.reverse().map(cardMarkup).join("") : `<div class="empty">No bounties yet. Be the first project owner to post one.</div>`; document.querySelectorAll<HTMLButtonElement>("[data-id]").forEach((button) => button.addEventListener("click", () => void showDetail(Number(button.dataset.id)))); $("#sync").textContent = `Synced ${list.length} opportunities`; }
async function showDetail(id: number) { selectedId = id; const b = normalized(await simulate(ESCROW_ID, "get_bounty", [id], ["u64"])); const canApply = b.status === "Open" && b.creator !== walletAddress; const canSubmit = b.status === "Assigned" && b.builder === walletAddress; const canApprove = b.status === "Submitted" && b.creator === walletAddress; $("#detail").innerHTML = `<div class="section-heading"><div><div class="eyebrow">BOUNTY #${String(b.id).padStart(3, "0")}</div><h2>${b.title}</h2></div><span class="tag ${b.status.toLowerCase()}">${b.status}</span></div><p class="detail-copy">${b.description}</p><div class="detail-meta"><span><small>Reward</small><strong>${stellarFromStroops(b.reward)} XLM</strong></span><span><small>Owner</small><strong>${shortAddress(b.creator)}</strong></span><span><small>Deadline</small><strong>Ledger ${b.deadline}</strong></span></div>${b.proof ? `<div class="proof"><small>Submitted proof</small><a href="${b.proof}" target="_blank" rel="noreferrer">${b.proof} ↗</a></div>` : ""}<div class="detail-actions">${canApply ? `<button id="apply" class="button">Apply to build ↗</button>` : ""}${canSubmit ? `<form id="submit-form" class="inline-form"><input id="proof" required placeholder="Paste PR or demo URL" /><button class="button">Submit proof ↗</button></form>` : ""}${canApprove ? `<button id="approve" class="button">Approve & release ${stellarFromStroops(b.reward)} XLM ↗</button>` : ""}${b.status === "Open" && b.creator === walletAddress ? `<button id="cancel" class="button danger">Cancel & refund</button>` : ""}${!canApply && !canSubmit && !canApprove && b.status !== "Paid" && b.status !== "Cancelled" ? `<span class="muted">Connect the eligible wallet to continue.</span>` : ""}</div>`; $("#detail").classList.remove("hidden"); $("#apply")?.addEventListener("click", () => void action("Applying to bounty…", "apply_bounty", [walletAddress, id], ["address", "u64"])); $("#approve")?.addEventListener("click", () => void action("Releasing escrow and updating reputation…", "approve_and_pay", [walletAddress, id], ["address", "u64"])); $("#cancel")?.addEventListener("click", () => void action("Refunding escrow…", "cancel_bounty", [walletAddress, id], ["address", "u64"])); $("#submit-form")?.addEventListener("submit", (event) => { event.preventDefault(); void action("Recording your proof…", "submit_work", [walletAddress, id, ($("#proof") as HTMLInputElement).value], ["address", "u64", "string"]); }); }
async function action(message: string, method: string, args: unknown[], types: string[]) { try { setStatus(message); const hash = await write(ESCROW_ID, method, args, types); setStatus(`Confirmed on Testnet · ${shortAddress(hash)}`, "success"); await refreshBounties(); await refreshProfile(); await refreshEvents(); if (selectedId) await showDetail(selectedId); } catch (error) { setStatus(formatError(error), "error"); } }
async function refreshProfile() { const profile = await simulate(REPUTATION_ID, "get_profile", [active()], ["address"]); $("#wallet-label").textContent = shortAddress(walletAddress); $("#completions").textContent = String(profile.completions ?? 0); $("#earned").textContent = stellarFromStroops(BigInt(profile.earned ?? 0)); }
async function refreshEvents() { const latest = await rpcServer.getLatestLedger(); const result = await rpcServer.getEvents({ startLedger: Math.max(1, latest.sequence - 500), filters: [{ type: "contract", contractIds: [ESCROW_ID, REPUTATION_ID] }], limit: 30 }); const fresh = result.events.filter((event) => !seenEvents.has(event.id)); fresh.forEach((event) => seenEvents.add(event.id)); if (fresh.length) { const rows = fresh.reverse().map((event) => { const kind = String(scValToNative(event.topic[0])); const id = event.topic[2] ? String(scValToNative(event.topic[2])) : ""; return `<div class="event-row"><div class="event-icon">✦</div><div><strong>${kind === "complete" ? "Reputation updated" : `Bounty ${kind}`}</strong><span>${id ? `Bounty #${id} · ` : ""}ledger ${event.ledger} · <a href="https://stellar.expert/explorer/testnet/tx/${event.txHash}" target="_blank" rel="noreferrer">view tx ↗</a></span></div></div>`; }).join(""); $("#events").insertAdjacentHTML("afterbegin", rows); } $("#sync").textContent = `Live · ledger ${latest.sequence}`; }
connectButton.addEventListener("click", async () => { try { if (!configured()) throw new Error("Testnet contracts are not configured yet."); const connection = await isConnected(); if (!connection.isConnected) throw new Error("Freighter was not detected. Open the extension and reload this page."); const access = await requestAccess(); if (access.error) throw new Error(typeof access.error === "string" ? access.error : access.error.message); const network = await getNetworkDetails(); if (network.error) throw new Error(typeof network.error === "string" ? network.error : network.error.message); if (network.network !== "TESTNET") throw new Error("Switch Freighter to Stellar Testnet, then connect again."); walletAddress = access.address; $("#wallet-label").textContent = shortAddress(walletAddress); connectButton.textContent = "Wallet connected"; setStatus("Wallet connected. Syncing escrow marketplace…", "success"); await Promise.all([refreshBounties(), refreshProfile(), refreshEvents()]); if (syncTimer === undefined) syncTimer = window.setInterval(() => { void Promise.all([refreshBounties(), refreshProfile(), refreshEvents()]).catch((error) => setStatus(formatError(error), "error")); }, 8000); } catch (error) { walletAddress = ""; setStatus(formatError(error), "error"); } });
$("#create-form").addEventListener("submit", (event) => { event.preventDefault(); const reward = Number(($("#reward") as HTMLInputElement).value); const days = Number(($("#days") as HTMLInputElement).value); void (async () => { const latest = await rpcServer.getLatestLedger(); await action("Simulating XLM escrow funding…", "create_bounty", [walletAddress, ($("#title") as HTMLInputElement).value, ($("#description") as HTMLTextAreaElement).value, Math.round(reward * 10_000_000), latest.sequence + Math.round(days * 8_640)], ["address", "string", "string", "i128", "u64"]); })(); });
