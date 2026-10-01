// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { Vault } from "../contracts/Vault.sol";
import { OpsDenylistAddExact } from "../script/OpsDenylist.s.sol";
import { OpsVaultRegister } from "../script/OpsVault.s.sol";

contract OpsLiveGuardTest is Test {
    using stdJson for string;

    OpsDenylistAddExact internal denylistOp;
    OpsVaultRegister internal vaultOp;
    address internal liveDenylist;
    address internal liveVault;
    address internal liveTimelock;
    address internal oldDenylist;
    address internal oldVault;

    function setUp() public {
        denylistOp = new OpsDenylistAddExact();
        vaultOp = new OpsVaultRegister();
        liveDenylist = denylistOp.LIVE_DENYLIST();
        liveVault = denylistOp.LIVE_VAULT();
        liveTimelock = denylistOp.LIVE_TIMELOCK();
        oldDenylist = denylistOp.SUPERSEDED_DENYLIST();
        oldVault = denylistOp.SUPERSEDED_VAULT();
    }

    function test_canonicalAddressesMatchDeploymentBook() public view {
        string memory book = vm.readFile("deployments/base-sepolia.json");
        assertEq(book.readAddress(".Denylist.address"), liveDenylist);
        assertEq(book.readAddress(".Vault.address"), liveVault);
        assertEq(book.readAddress(".coreTimelock"), liveTimelock);
        assertEq(book.readAddress(".superseded.Denylist.address"), oldDenylist);
        assertEq(book.readAddress(".superseded.Vault.address"), oldVault);
        assertEq(book.readUint(".chainId"), denylistOp.ALLOWED_CHAIN_ID());
        assertEq(vaultOp.LIVE_DENYLIST(), liveDenylist);
        assertEq(vaultOp.LIVE_VAULT(), liveVault);
        assertEq(vaultOp.LIVE_TIMELOCK(), liveTimelock);
    }

    function test_allowsBaseSepoliaOnly() public {
        vm.chainId(84532);
        denylistOp.requireAllowedChain();
        vaultOp.requireAllowedChain();
    }

    function test_refusesMainnet() public {
        vm.chainId(1);
        vm.expectRevert(bytes("OpsLive: mainnet forbidden"));
        denylistOp.requireAllowedChain();
        vm.expectRevert(bytes("OpsLive: mainnet forbidden"));
        vaultOp.requireAllowedChain();
    }

    function test_refusesOtherChains() public {
        vm.chainId(11155111);
        vm.expectRevert(bytes("OpsLive: Base Sepolia (84532) only"));
        denylistOp.requireAllowedChain();
        vm.chainId(31337);
        vm.expectRevert(bytes("OpsLive: Base Sepolia (84532) only"));
        vaultOp.requireAllowedChain();
    }

    function test_refusesSupersededAndUnknownAddresses() public {
        vm.expectRevert(bytes("OpsLive: superseded Denylist"));
        denylistOp.assertCanonicalDenylist(oldDenylist, liveTimelock);

        vm.expectRevert(bytes("OpsLive: DENYLIST is not the live Base Sepolia Denylist"));
        denylistOp.assertCanonicalDenylist(address(0x1234), liveTimelock);

        vm.expectRevert(bytes("OpsLive: CORE_TIMELOCK is not the live owner"));
        denylistOp.assertCanonicalDenylist(liveDenylist, address(0x1234));

        denylistOp.assertCanonicalDenylist(liveDenylist, liveTimelock);

        vm.expectRevert(bytes("OpsLive: superseded Vault"));
        vaultOp.assertCanonicalVault(liveDenylist, oldVault, liveTimelock);

        vm.expectRevert(bytes("OpsLive: VAULT is not the live Base Sepolia Vault"));
        vaultOp.assertCanonicalVault(liveDenylist, address(0x1234), liveTimelock);

        vaultOp.assertCanonicalVault(liveDenylist, liveVault, liveTimelock);
    }

    function test_parseBucketAndTier() public view {
        assertEq(uint256(denylistOp.parseBucket("Exact")), uint256(Denylist.Bucket.Exact));
        assertEq(uint256(denylistOp.parseBucket("Signature")), uint256(Denylist.Bucket.Signature));
        assertEq(uint256(denylistOp.parseBucket("Prompt")), uint256(Denylist.Bucket.Prompt));
        assertEq(uint256(vaultOp.parseTier("None")), uint256(Vault.Tier.None));
        assertEq(uint256(vaultOp.parseTier("Chat")), uint256(Vault.Tier.Chat));
        assertEq(uint256(vaultOp.parseTier("DataTools")), uint256(Vault.Tier.DataTools));
        assertEq(uint256(vaultOp.parseTier("Financial")), uint256(Vault.Tier.Financial));
        assertEq(uint256(vaultOp.parseTier("Critical")), uint256(Vault.Tier.Critical));
    }

    function test_parseBucketRejectsUnknown() public {
        vm.expectRevert(bytes("OpsLive: BUCKET must be Exact, Signature, or Prompt"));
        denylistOp.parseBucket("exact");
    }

    function test_parseTierRejectsUnknown() public {
        vm.expectRevert(bytes("OpsLive: TIER must be None, Chat, DataTools, Financial, or Critical"));
        vaultOp.parseTier("3");
    }

    function test_readUnsetEnvReverts() public {
        vm.expectRevert(bytes("OpsLive: DENYLIST unset"));
        denylistOp.readAddress("OPS_LIVE_UNSET_ADDRESS", "OpsLive: DENYLIST unset");
        vm.expectRevert(bytes("OpsLive: LISTING_ID unset"));
        denylistOp.readBytes32("OPS_LIVE_UNSET_BYTES32", "OpsLive: LISTING_ID unset");
        vm.expectRevert(bytes("OpsLive: BUCKET unset"));
        denylistOp.readString("OPS_LIVE_UNSET_STRING", "OpsLive: BUCKET unset");
    }

    function test_onchainOwnerAndDenylistPointerGuards() public {
        vm.expectRevert(bytes("OpsLive: Denylist.owner is not CORE_TIMELOCK"));
        denylistOp.assertDenylistOwner(address(0x1234), liveTimelock);
        denylistOp.assertDenylistOwner(liveTimelock, liveTimelock);

        vm.expectRevert(bytes("OpsLive: Vault.owner is not CORE_TIMELOCK"));
        vaultOp.assertVaultWired(address(0x1234), liveDenylist, liveDenylist, liveTimelock);

        vm.expectRevert(bytes("OpsLive: Vault.denylist is not DENYLIST"));
        vaultOp.assertVaultWired(liveTimelock, oldDenylist, liveDenylist, liveTimelock);
        vaultOp.assertVaultWired(liveTimelock, liveDenylist, liveDenylist, liveTimelock);
    }

    function test_testContextIsNotBroadcast() public view {
        assertFalse(denylistOp.broadcasting());
        assertFalse(vaultOp.broadcasting());
    }
}
