// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { console2 } from "forge-std/console2.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { Vault } from "../contracts/Vault.sol";

/// @notice Fork coverage for the live Base Sepolia Denylist + Vault pair.
///         Mutations are `vm.prank` on the fork. This file never broadcasts.
///
///         Run:
///         forge test --fork-url https://base-sepolia.gateway.tenderly.co --match-contract LiveDenylistVaultTest -vv
///
///         With no fork and no `BASE_SEPOLIA_RPC_URL`, every test skips so
///         offline `forge test` does not require an RPC.
contract LiveDenylistVaultTest is Test {
    address internal constant DENYLIST = 0xeE76876bECcFc1B58fC06fF4E654a517d784B224;
    address internal constant VAULT = 0x1463D664fA467FBCDA4B05443434494f05e565bc;
    address internal constant CORE_TIMELOCK = 0x10CC9474b45625ADfd05C209f2518023484878D9;
    /// @dev Deploy sender of both creation txs. Not an owner on this pair.
    address internal constant DEPLOY_SENDER = 0x5D467FA00eC0E92044f779e495a17db66c5964aa;
    /// @dev EIP-7702 designator target read from CORE_TIMELOCK code (`0xef0100 || address`).
    address internal constant TIMELOCK_DELEGATE = 0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B;

    uint256 internal constant BASE_SEPOLIA = 84532;

    /// @dev Pre-PR23 live Denylist runtime (source 78e3ba0, deployed 2026-09-25).
    ///      Main now adds InvalidBucket, so this is not `type(Denylist).runtimeCode`.
    ///      TODO: update when the Denylist is redeployed from main.
    bytes32 internal constant LIVE_DENYLIST_PRE_PR23_RUNTIME_HASH =
        0x6d58afc07cebf667421cd28c317e937db9d1ee8df62ee507c48cc13e66b77dc4;

    bytes32 internal constant WEIGHT = keccak256("qa-live-denylist-vault-weight");
    bytes32 internal constant SIG = keccak256("qa-live-denylist-vault-sig");
    bytes32 internal constant PROMPT = keccak256("qa-live-denylist-vault-prompt");
    bytes32 internal constant BOT = keccak256("qa-live-denylist-vault-bot");

    Denylist internal denylist;
    Vault internal vault;

    function setUp() public {
        if (block.chainid != BASE_SEPOLIA) {
            string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
            if (bytes(rpc).length == 0) {
                vm.skip(true, "set BASE_SEPOLIA_RPC_URL or pass --fork-url for Base Sepolia (84532)");
                return;
            }
            vm.createSelectFork(rpc);
        }
        if (block.chainid != BASE_SEPOLIA) {
            vm.skip(true, "fork is not Base Sepolia (84532)");
            return;
        }

        denylist = Denylist(DENYLIST);
        vault = Vault(VAULT);
        console2.log("live fork block", block.number);
    }

    function test_forkIsBaseSepoliaAndDenylistRuntimeIsPrePr23() public view {
        assertEq(block.chainid, BASE_SEPOLIA);
        assertGt(DENYLIST.code.length, 0);
        assertGt(VAULT.code.length, 0);
        assertEq(keccak256(DENYLIST.code), LIVE_DENYLIST_PRE_PR23_RUNTIME_HASH);
        // Live Vault opcodes match this source. The appended CBOR metadata hash does not,
        // so the full runtime blob is not compared to `type(Vault).runtimeCode`.
    }

    function test_ownerAndPendingOwnerAreCoreTimelock() public view {
        assertEq(denylist.owner(), CORE_TIMELOCK);
        assertEq(denylist.pendingOwner(), address(0));
        assertEq(vault.owner(), CORE_TIMELOCK);
        assertEq(vault.pendingOwner(), address(0));
    }

    function test_vaultDenylistWiresLiveDenylist() public view {
        assertEq(address(vault.denylist()), DENYLIST);
    }

    function test_coreTimelockIsEip7702Delegated() public view {
        address impl = _eip7702Delegate(CORE_TIMELOCK);
        assertEq(impl, TIMELOCK_DELEGATE);
        assertGt(TIMELOCK_DELEGATE.code.length, 0);
    }

    function test_deploySenderIsNotOwner() public {
        assertTrue(DEPLOY_SENDER != denylist.owner());
        assertTrue(DEPLOY_SENDER != vault.owner());

        vm.startPrank(DEPLOY_SENDER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, DEPLOY_SENDER));
        denylist.addExact(WEIGHT);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, DEPLOY_SENDER));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat);
        vm.stopPrank();

        assertFalse(denylist.everListed(uint8(Denylist.Bucket.Exact), WEIGHT));
        (,,,,, uint256 registeredAt) = vault.bots(BOT);
        assertEq(registeredAt, 0);
    }

    function test_cleanViewsAndTierCaps() public {
        assertEq(uint256(denylist.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.None));
        assertFalse(denylist.denylistedHashes(WEIGHT));
        assertFalse(denylist.denylistedSignatures(SIG));
        assertFalse(denylist.denylistedPrompts(PROMPT));
        assertFalse(denylist.everListed(uint8(Denylist.Bucket.Exact), WEIGHT));
        assertFalse(denylist.everListed(uint8(Denylist.Bucket.Signature), SIG));
        assertFalse(denylist.everListed(uint8(Denylist.Bucket.Prompt), PROMPT));

        Denylist.Listing memory row = denylist.listing(uint8(Denylist.Bucket.Exact), WEIGHT);
        assertFalse(row.active);
        assertEq(row.timesListed, 0);
        assertEq(row.firstListedAt, 0);
        assertEq(row.lastListedBy, address(0));

        assertEq(vault.tierMaxPermissions(Vault.Tier.None), 0);
        assertEq(vault.tierMaxPermissions(Vault.Tier.Chat), 1);
        assertEq(vault.tierMaxPermissions(Vault.Tier.DataTools), 2);
        assertEq(vault.tierMaxPermissions(Vault.Tier.Financial), 3);
        assertEq(vault.tierMaxPermissions(Vault.Tier.Critical), 4);

        vm.expectRevert(bytes("bot not active"));
        vault.grantAccess(BOT, 1);
    }

    function test_checkIsStaticAndWritesNothing() public {
        vm.record();
        (bool ok, bytes memory ret) =
            address(denylist).staticcall(abi.encodeWithSignature("check(bytes32,bytes32,bytes32)", WEIGHT, SIG, PROMPT));
        assertTrue(ok);
        assertEq(abi.decode(ret, (uint8)), uint8(Denylist.MatchLevel.None));
        (, bytes32[] memory writes) = vm.accesses(address(denylist));
        assertEq(writes.length, 0);
    }

    function test_strangerCannotAddRemoveOrTransfer() public {
        address eve = address(0xBAD);
        // Fork gas price is the live base fee. An unfunded prank reverts before calldata
        // runs. The deal exists only so the access-control call is simulated.
        vm.deal(eve, 1 ether);

        vm.startPrank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        denylist.addExact(WEIGHT);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        denylist.addSignature(SIG);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        denylist.addPrompt(PROMPT);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        denylist.remove(WEIGHT, uint8(Denylist.Bucket.Exact));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        denylist.transferOwnership(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        denylist.acceptOwnership();
        vm.stopPrank();

        assertEq(denylist.owner(), CORE_TIMELOCK);
        assertEq(denylist.pendingOwner(), address(0));
        assertFalse(denylist.everListed(uint8(Denylist.Bucket.Exact), WEIGHT));
    }

    function test_strangerCannotRegisterBurnOrSetOperator() public {
        address eve = address(0xBAD);
        // Same fork gas-price funding as the denylist stranger test. Not a live balance.
        vm.deal(eve, 1 ether);

        vm.startPrank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat, eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        vault.setOperator(BOT, eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        vault.burn(BOT);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        vault.transferOwnership(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        vault.acceptOwnership();
        vm.stopPrank();

        assertEq(vault.owner(), CORE_TIMELOCK);
        assertEq(vault.pendingOwner(), address(0));
        (,,,,, uint256 registeredAt) = vault.bots(BOT);
        assertEq(registeredAt, 0);
    }

    function test_acceptOwnershipRevertsWhilePendingIsZero() public {
        vm.startPrank(CORE_TIMELOCK);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, CORE_TIMELOCK));
        denylist.acceptOwnership();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, CORE_TIMELOCK));
        vault.acceptOwnership();
        vm.stopPrank();

        assertEq(denylist.owner(), CORE_TIMELOCK);
        assertEq(vault.owner(), CORE_TIMELOCK);
    }

    function test_timelockListUnbanKeepsHistoryAndGatesRegister() public {
        vm.startPrank(CORE_TIMELOCK);
        denylist.addExact(WEIGHT);
        denylist.addSignature(SIG);
        denylist.addPrompt(PROMPT);
        vm.stopPrank();

        assertEq(uint256(denylist.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.ExactBlock));
        assertTrue(denylist.denylistedHashes(WEIGHT));
        assertEq(denylist.listing(uint8(Denylist.Bucket.Exact), WEIGHT).lastListedBy, CORE_TIMELOCK);
        assertEq(denylist.listing(uint8(Denylist.Bucket.Exact), WEIGHT).timesListed, 1);

        vm.prank(CORE_TIMELOCK);
        vm.expectRevert(bytes("bot is denylisted"));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Critical);

        vm.prank(CORE_TIMELOCK);
        denylist.remove(WEIGHT, uint8(Denylist.Bucket.Exact));
        assertEq(uint256(denylist.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.SignatureBlock));

        vm.prank(CORE_TIMELOCK);
        denylist.remove(SIG, uint8(Denylist.Bucket.Signature));
        assertEq(uint256(denylist.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.PromptBlock));
        assertTrue(denylist.denylistedPrompts(PROMPT));

        vm.prank(CORE_TIMELOCK);
        denylist.remove(PROMPT, uint8(Denylist.Bucket.Prompt));

        assertEq(uint256(denylist.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.None));
        assertFalse(denylist.denylistedHashes(WEIGHT));
        assertFalse(denylist.denylistedSignatures(SIG));
        assertFalse(denylist.denylistedPrompts(PROMPT));
        assertTrue(denylist.everListed(uint8(Denylist.Bucket.Exact), WEIGHT));
        assertTrue(denylist.everListed(uint8(Denylist.Bucket.Signature), SIG));
        assertTrue(denylist.everListed(uint8(Denylist.Bucket.Prompt), PROMPT));

        Denylist.Listing memory cleared = denylist.listing(uint8(Denylist.Bucket.Prompt), PROMPT);
        assertFalse(cleared.active);
        assertEq(cleared.timesListed, 1);
        assertGt(cleared.firstListedAt, 0);
        assertEq(cleared.lastListedAt, cleared.firstListedAt);
        assertGe(cleared.lastUnlistedAt, cleared.lastListedAt);
        assertEq(cleared.lastListedBy, CORE_TIMELOCK);
        assertEq(cleared.lastUnlistedBy, CORE_TIMELOCK);

        vm.prank(CORE_TIMELOCK);
        denylist.addPrompt(PROMPT);
        assertEq(denylist.listing(uint8(Denylist.Bucket.Prompt), PROMPT).timesListed, 2);
        assertEq(uint256(denylist.check(bytes32(0), bytes32(0), PROMPT)), uint256(Denylist.MatchLevel.PromptBlock));

        vm.prank(CORE_TIMELOCK);
        vm.expectRevert(bytes("bot is denylisted"));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat);

        vm.prank(CORE_TIMELOCK);
        denylist.remove(PROMPT, uint8(Denylist.Bucket.Prompt));
        assertEq(denylist.listing(uint8(Denylist.Bucket.Prompt), PROMPT).timesListed, 2);
        assertTrue(denylist.everListed(uint8(Denylist.Bucket.Prompt), PROMPT));

        uint256 vaultBefore = VAULT.balance;
        uint256 denyBefore = DENYLIST.balance;
        vm.prank(CORE_TIMELOCK);
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Financial);
        assertEq(VAULT.balance, vaultBefore);
        assertEq(DENYLIST.balance, denyBefore);

        (bytes32 weight, bytes32 sig, bytes32 prompt, Vault.Tier tier, bool active, uint256 registeredAt) =
            vault.bots(BOT);
        assertEq(weight, WEIGHT);
        assertEq(sig, SIG);
        assertEq(prompt, PROMPT);
        assertEq(uint256(tier), uint256(Vault.Tier.Financial));
        assertTrue(active);
        assertGt(registeredAt, 0);
        assertTrue(vault.grantAccess(BOT, 3));
        assertFalse(vault.grantAccess(BOT, 4));
    }

    function test_paidCallsRevertAndOwnerZeroValuePathPersists() public {
        uint256 vaultBefore = VAULT.balance;
        uint256 denyBefore = DENYLIST.balance;

        vm.prank(CORE_TIMELOCK);
        (bool paidAdd,) = address(denylist).call{ value: 1 }(abi.encodeWithSignature("addExact(bytes32)", WEIGHT));
        assertFalse(paidAdd);
        assertFalse(denylist.denylistedHashes(WEIGHT));

        vm.prank(CORE_TIMELOCK);
        (bool paidRegister,) = address(vault).call{ value: 1 }(
            abi.encodeWithSignature(
                "register(bytes32,bytes32,bytes32,bytes32,uint8)", BOT, WEIGHT, SIG, PROMPT, uint8(Vault.Tier.Chat)
            )
        );
        assertFalse(paidRegister);

        vm.prank(CORE_TIMELOCK);
        (bool freeAdd,) = address(denylist).call(abi.encodeWithSignature("addExact(bytes32)", WEIGHT));
        assertTrue(freeAdd);
        assertTrue(denylist.denylistedHashes(WEIGHT));

        vm.prank(CORE_TIMELOCK);
        denylist.remove(WEIGHT, uint8(Denylist.Bucket.Exact));

        address operator = address(0xBEEF);
        vm.prank(CORE_TIMELOCK);
        (bool freeRegister,) = address(vault)
            .call(
                abi.encodeWithSignature(
                    "register(bytes32,bytes32,bytes32,bytes32,uint8,address)",
                    BOT,
                    WEIGHT,
                    SIG,
                    PROMPT,
                    uint8(Vault.Tier.DataTools),
                    operator
                )
            );
        assertTrue(freeRegister);
        assertEq(vault.operator(BOT), operator);
        assertTrue(vault.grantAccess(BOT, 2));
        assertFalse(vault.grantAccess(BOT, 3));

        vm.prank(CORE_TIMELOCK);
        vault.burn(BOT);
        (,,,, bool active,) = vault.bots(BOT);
        assertFalse(active);
        vm.expectRevert(bytes("bot not active"));
        vault.grantAccess(BOT, 1);
        vm.prank(CORE_TIMELOCK);
        vm.expectRevert(bytes("not active"));
        vault.burn(BOT);
        vm.prank(CORE_TIMELOCK);
        vm.expectRevert(bytes("already registered"));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Critical);

        assertEq(VAULT.balance, vaultBefore);
        assertEq(DENYLIST.balance, denyBefore);
        assertEq(denylist.listing(uint8(Denylist.Bucket.Exact), WEIGHT).timesListed, 1);
        assertTrue(denylist.everListed(uint8(Denylist.Bucket.Exact), WEIGHT));
        assertEq(uint256(denylist.check(WEIGHT, bytes32(0), bytes32(0))), uint256(Denylist.MatchLevel.None));
    }

    function _eip7702Delegate(
        address account
    ) internal view returns (address impl) {
        bytes memory code = account.code;
        assertEq(code.length, 23);
        assertEq(uint8(code[0]), 0xef);
        assertEq(uint8(code[1]), 0x01);
        assertEq(uint8(code[2]), 0x00);
        assembly {
            impl := shr(96, mload(add(add(code, 32), 3)))
        }
    }
}
