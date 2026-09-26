import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOKED_SEPOLIA_ESCROW, BOOKED_SEPOLIA_ESCROW_START_BLOCK, DEFAULT_RELAYER_ADDRESS, healthPayload, liveSubmitStatus, loadConfig } from "../config.mjs";

const SECRET = "0x" + "ab".repeat(32);

describe("config gates", () => {
  it("defaults to Base Sepolia fixtures and the public hot wallet", () => {
    const config = loadConfig({ RELAYER_PRIVATE_KEY: SECRET });
    assert.equal(config.chainId, 84532);
    assert.equal(config.relayerAddress, DEFAULT_RELAYER_ADDRESS);
    assert.equal(config.escrowBooked, true);
    assert.equal(config.escrowSource, "address_book");
    assert.equal(config.escrowAddress, "0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d");
    assert.equal(config.escrowStartBlock, 47345163);
    assert.equal(config.escrowStartBlock, BOOKED_SEPOLIA_ESCROW_START_BLOCK);
    assert.equal(config.disputePanelAddress, "0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb");
    assert.equal(config.coreTimelock, "0x10CC9474b45625ADfd05C209f2518023484878D9");
    assert.equal(config.bvtAddress, null);
    assert.equal(config.liveSubmit.allowed, false);
    assert.equal(config.claimApiSecret, "");
    assert.deepEqual(config.liveSubmit.blockers, ["spencer_run_auth_required", "live_submit_off"]);
    assert.equal(JSON.stringify(config).includes(SECRET), false);
    assert.equal(Object.hasOwn(config, "RELAYER_PRIVATE_KEY"), false);
  });

  it("treats a zero escrow address as unbooked and a real one as booked", () => {
    const zero = loadConfig({ ESCROW_ADDRESS: "0x0000000000000000000000000000000000000000" });
    assert.equal(zero.escrowBooked, false);
    const booked = loadConfig({
      ESCROW_ADDRESS: "0x1111111111111111111111111111111111111111",
      LIVE_SUBMIT: "1",
      SPENCER_RUN_AUTH: "1",
    });
    assert.equal(booked.escrowBooked, true);
    assert.equal(booked.escrowSource, "env");
    assert.equal(booked.liveSubmit.allowed, false);
    assert.equal(booked.liveSubmit.requested, true);
    assert.equal(booked.liveSubmit.spencerAuth, true);
    assert.deepEqual(booked.liveSubmit.blockers, ["escrow_not_booked_sepolia"]);
  });

  it("keeps CLAIM_API_SECRET off the health payload", () => {
    const config = loadConfig({
      LIVE_SUBMIT: "1",
      SPENCER_RUN_AUTH: "1",
      CLAIM_API_SECRET: "claim-health-secret",
      ADMIN_SECRET: "admin-health-secret",
    });
    assert.equal(config.claimApiSecret, "claim-health-secret");
    assert.equal(config.adminSecret, "admin-health-secret");
    const health = JSON.stringify(healthPayload(config, false));
    assert.equal(health.includes("claim-health-secret"), false);
    assert.equal(health.includes("admin-health-secret"), false);
    assert.equal(health.includes("CLAIM_API_SECRET"), false);
  });

  it("allows live submit only for the booked Base Sepolia escrow", async () => {
    const unlocked = loadConfig({ LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" });
    assert.equal(unlocked.chainId, 84532);
    assert.equal(unlocked.escrowAddress, BOOKED_SEPOLIA_ESCROW);
    assert.equal(unlocked.liveSubmit.allowed, true);
    assert.deepEqual(unlocked.liveSubmit.blockers, []);
    assert.equal(JSON.stringify(unlocked).includes(SECRET), false);
    const book = JSON.parse(await readFile(new URL("../../deployments/base-sepolia.json", import.meta.url), "utf8"));
    assert.equal(book.chainId, 84532);
    assert.equal(book.BotAttestationEscrow.address, BOOKED_SEPOLIA_ESCROW);
    assert.equal(book.BotAttestationEscrow.startBlock, BOOKED_SEPOLIA_ESCROW_START_BLOCK);
    assert.equal(book.retired.BotAttestationEscrow.reason, "ESC-M-1 redeploy, retired 2026-09-26");
    assert.equal(book.claimRelayerWallet, DEFAULT_RELAYER_ADDRESS);

    const explicit = liveSubmitStatus(
      { LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" },
      { escrowBooked: true, escrowAddress: BOOKED_SEPOLIA_ESCROW, chainId: 84532 },
    );
    assert.equal(explicit.allowed, true);
    assert.equal(explicit.error, null);
  });

  it("refuses a mainnet address book", async () => {
    const dir = await mkdtemp(join(tmpdir(), "book-"));
    const filePath = join(dir, "book.json");
    await writeFile(filePath, JSON.stringify({ chainId: 8453, network: "base", BotAttestationEscrow: { address: null } }));
    assert.equal(loadConfigThrows({ ADDRESS_BOOK_PATH: filePath }), "mainnet_refused");
  });

  it("refuses mainnet and every other chain", () => {
    assert.equal(loadConfigThrows({ CHAIN_ID: "1", LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" }), "mainnet_refused");
    assert.equal(loadConfigThrows({ CHAIN_ID: "8453", LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" }), "mainnet_refused");
    assert.equal(loadConfigThrows({ CHAIN_ID: "11155111" }), "wrong_chain");
    assert.equal(loadConfigThrows({ CHAIN_ID: "421614" }), "wrong_chain");
    const mainnet = liveSubmitStatus(
      { LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" },
      { escrowBooked: true, escrowAddress: BOOKED_SEPOLIA_ESCROW, chainId: 8453 },
    );
    assert.equal(mainnet.allowed, false);
    assert.ok(mainnet.blockers.includes("mainnet_refused"));
    const ethereum = liveSubmitStatus(
      { LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" },
      { escrowBooked: true, escrowAddress: BOOKED_SEPOLIA_ESCROW, chainId: 1 },
    );
    assert.equal(ethereum.allowed, false);
    assert.ok(ethereum.blockers.includes("mainnet_refused"));
  });

  it("refuses a key file env", () => {
    assert.equal(loadConfigThrows({ RELAYER_PRIVATE_KEY_FILE: "/tmp/key" }), "key_file_forbidden");
  });

  it("keeps live submit blocked when the booked address is missing", () => {
    const status = liveSubmitStatus({ LIVE_SUBMIT: "1", SPENCER_RUN_AUTH: "1" }, true);
    assert.equal(status.allowed, false);
    assert.equal(status.error, "live_submit_blocked");
    assert.ok(status.blockers.includes("escrow_not_booked_sepolia"));
  });

  it("sends only from broadcast.mjs and never adds a forge broadcast", async () => {
    const quiet = [
      "app.mjs",
      "server.mjs",
      "claims.mjs",
      "config.mjs",
      "retry.mjs",
      "escrowCalldata.mjs",
      "addressBook.mjs",
      "readonlyEscrow.mjs",
    ];
    for (const name of quiet) {
      const text = await readFile(new URL(`../${name}`, import.meta.url), "utf8");
      assert.equal(text.includes("eth_sendRawTransaction"), false, name);
      assert.equal(text.includes("forge script"), false, name);
      assert.equal(text.includes("--broadcast"), false, name);
      assert.equal(text.includes(SECRET), false, name);
    }
    const sender = await readFile(new URL("../broadcast.mjs", import.meta.url), "utf8");
    assert.equal(sender.includes("eth_sendRawTransaction"), true);
    assert.equal(sender.includes("forge script"), false);
    assert.equal(sender.includes("--broadcast"), false);
    assert.equal(sender.includes(SECRET), false);
    assert.equal(sender.includes('from "viem/chains"'), true);
    assert.equal(sender.includes("baseSepolia"), true);
    assert.equal(/\bmainnet\b/.test(sender), false);
  });
});

function loadConfigThrows(env) {
  try {
    loadConfig(env);
  } catch (err) {
    return err.error;
  }
  assert.fail("expected loadConfig to throw");
}
