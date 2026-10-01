// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { IVault } from "../contracts/interfaces/IVault.sol";
import { Vault } from "../contracts/Vault.sol";

contract VaultTest is Test {
    Denylist internal denylist;
    Vault internal vault;

    bytes32 internal constant BOT = keccak256("vault-bot");
    bytes32 internal constant WEIGHT = keccak256("weight");
    bytes32 internal constant SIG = keccak256("sig");
    bytes32 internal constant PROMPT = keccak256("prompt");

    function setUp() public {
        denylist = new Denylist();
        vault = new Vault(address(denylist));
    }

    function test_constructorSetsDenylistOwnerAndTierCaps() public view {
        assertEq(address(vault.denylist()), address(denylist));
        assertEq(vault.owner(), address(this));
        assertEq(vault.pendingOwner(), address(0));
        assertEq(vault.tierMaxPermissions(Vault.Tier.Chat), 1);
        assertEq(vault.tierMaxPermissions(Vault.Tier.DataTools), 2);
        assertEq(vault.tierMaxPermissions(Vault.Tier.Financial), 3);
        assertEq(vault.tierMaxPermissions(Vault.Tier.Critical), 4);
        assertEq(vault.tierMaxPermissions(Vault.Tier.None), 0);
    }

    function test_registerAgainstUnsetDenylistReverts() public {
        Vault unbound = new Vault(address(0));
        assertEq(address(unbound.denylist()), address(0));
        vm.expectRevert();
        unbound.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat);
    }

    function test_registerRejectsEveryDenylistMatchLevel() public {
        denylist.addExact(WEIGHT);
        assertEq(uint256(denylist.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.ExactBlock));
        vm.expectRevert(bytes("bot is denylisted"));
        vault.register(keccak256("exact"), WEIGHT, SIG, PROMPT, Vault.Tier.Chat);

        bytes32 sig = keccak256("blocked-sig");
        denylist.addSignature(sig);
        assertEq(
            uint256(denylist.check(keccak256("clean-w"), sig, PROMPT)), uint256(Denylist.MatchLevel.SignatureBlock)
        );
        vm.expectRevert(bytes("bot is denylisted"));
        vault.register(keccak256("sig"), keccak256("clean-w"), sig, PROMPT, Vault.Tier.DataTools);

        bytes32 prompt = keccak256("blocked-prompt");
        denylist.addPrompt(prompt);
        assertEq(
            uint256(denylist.check(keccak256("clean-w2"), keccak256("clean-s"), prompt)),
            uint256(Denylist.MatchLevel.PromptBlock)
        );
        vm.expectRevert(bytes("bot is denylisted"));
        vault.register(keccak256("prompt"), keccak256("clean-w2"), keccak256("clean-s"), prompt, Vault.Tier.Financial);
    }

    function test_promptUnbanLetsRegisterSucceedAndKeepsHistory() public {
        denylist.addPrompt(PROMPT);
        vm.expectRevert(bytes("bot is denylisted"));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat);

        denylist.remove(PROMPT, uint8(Denylist.Bucket.Prompt));
        assertEq(uint256(denylist.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.None));
        assertTrue(denylist.everListed(uint8(Denylist.Bucket.Prompt), PROMPT));

        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat);
        (,,,, bool active,) = vault.bots(BOT);
        assertTrue(active);
    }

    function test_registerCleanBotAndBindOperator() public {
        address operator = address(0xBEEF);
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Financial, operator);

        (bytes32 weight, bytes32 sig, bytes32 prompt, Vault.Tier tier, bool active, uint256 registeredAt) =
            vault.bots(BOT);
        assertEq(weight, WEIGHT);
        assertEq(sig, SIG);
        assertEq(prompt, PROMPT);
        assertEq(uint256(tier), uint256(Vault.Tier.Financial));
        assertTrue(active);
        assertGt(registeredAt, 0);
        assertEq(vault.operator(BOT), operator);
        assertTrue(vault.grantAccess(BOT, 3));
        assertFalse(vault.grantAccess(BOT, 4));
    }

    function test_registerWithoutOperatorLeavesOperatorUnset() public {
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat);
        assertEq(vault.operator(BOT), address(0));
        assertTrue(vault.grantAccess(BOT, 1));
        assertFalse(vault.grantAccess(BOT, 2));
    }

    function test_doubleRegisterReverts() public {
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat);
        vm.expectRevert(bytes("already registered"));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Critical);
    }

    function test_zeroOperatorDoesNotRegister() public {
        vm.expectRevert(bytes("zero operator"));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat, address(0));
        (,,,,, uint256 registeredAt) = vault.bots(BOT);
        assertEq(registeredAt, 0);
    }

    function test_setOperatorRequiresKnownBotAndNonZero() public {
        vm.expectRevert(bytes("unknown bot"));
        vault.setOperator(BOT, address(0xBEEF));

        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat);
        vm.expectRevert(bytes("zero operator"));
        vault.setOperator(BOT, address(0));
        assertEq(vault.operator(BOT), address(0));

        vault.setOperator(BOT, address(0xBEEF));
        assertEq(vault.operator(BOT), address(0xBEEF));
    }

    function test_strangerCannotRegisterOrBurn() public {
        address eve = address(0xBAD);
        vm.startPrank(eve);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eve));
        vault.burn(BOT);
        vm.stopPrank();
    }

    function test_ownable2StepHandoff() public {
        address timelock = address(0x71C0);
        vault.transferOwnership(timelock);
        assertEq(vault.owner(), address(this));
        assertEq(vault.pendingOwner(), timelock);

        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        vault.acceptOwnership();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.acceptOwnership();

        vm.prank(timelock);
        vault.acceptOwnership();
        assertEq(vault.owner(), timelock);
        assertEq(vault.pendingOwner(), address(0));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Critical);

        vm.prank(timelock);
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Critical, timelock);
        assertEq(vault.operator(BOT), timelock);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.burn(BOT);

        vm.prank(timelock);
        vault.burn(BOT);
        (,,,, bool active,) = vault.bots(BOT);
        assertFalse(active);
    }

    function test_productPath_listBlocksRegister_removeThenRegisterBindsOperator() public {
        address operator = address(0x0B0);
        denylist.addExact(WEIGHT);
        denylist.addSignature(SIG);
        denylist.addPrompt(PROMPT);

        vm.expectRevert(bytes("bot is denylisted"));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Financial, operator);
        assertEq(vault.operator(BOT), address(0));
        (,,,,, uint256 registeredAt) = vault.bots(BOT);
        assertEq(registeredAt, 0);

        denylist.remove(WEIGHT, uint8(Denylist.Bucket.Exact));
        vm.expectRevert(bytes("bot is denylisted"));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Financial, operator);

        denylist.remove(SIG, uint8(Denylist.Bucket.Signature));
        vm.expectRevert(bytes("bot is denylisted"));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Financial, operator);

        denylist.remove(PROMPT, uint8(Denylist.Bucket.Prompt));
        assertEq(uint256(denylist.check(WEIGHT, SIG, PROMPT)), uint256(Denylist.MatchLevel.None));
        assertTrue(denylist.everListed(uint8(Denylist.Bucket.Exact), WEIGHT));
        assertTrue(denylist.everListed(uint8(Denylist.Bucket.Signature), SIG));
        assertTrue(denylist.everListed(uint8(Denylist.Bucket.Prompt), PROMPT));
        assertEq(denylist.listing(uint8(Denylist.Bucket.Prompt), PROMPT).timesListed, 1);

        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Financial, operator);
        assertEq(vault.operator(BOT), operator);
        (,,,, bool active,) = vault.bots(BOT);
        assertTrue(active);
        assertTrue(vault.grantAccess(BOT, 3));
    }

    function test_IVaultMatchesLiveRegisterOperatorAndBurn() public {
        IVault hook = IVault(address(vault));
        assertEq(hook.denylist(), address(denylist));
        assertEq(hook.owner(), address(this));
        assertEq(hook.pendingOwner(), address(0));
        assertEq(hook.tierMaxPermissions(IVault.Tier.Financial), 3);

        hook.register(BOT, WEIGHT, SIG, PROMPT, IVault.Tier.Financial);
        assertEq(hook.operator(BOT), address(0));
        (bytes32 weight,, bytes32 prompt, IVault.Tier tier, bool active, uint256 registeredAt) = hook.bots(BOT);
        assertEq(weight, WEIGHT);
        assertEq(prompt, PROMPT);
        assertEq(uint8(tier), uint8(IVault.Tier.Financial));
        assertTrue(active);
        assertGt(registeredAt, 0);
        assertTrue(hook.grantAccess(BOT, 3));
        assertFalse(hook.grantAccess(BOT, 4));

        bytes32 bot2 = keccak256("operator-bot");
        hook.register(bot2, WEIGHT, SIG, keccak256("other-prompt"), IVault.Tier.Chat, address(0xBEEF));
        assertEq(hook.operator(bot2), address(0xBEEF));
        hook.setOperator(bot2, address(0xCAFE));
        assertEq(hook.operator(bot2), address(0xCAFE));
        hook.burn(bot2);
        (,,,, bool burnedActive,) = hook.bots(bot2);
        assertFalse(burnedActive);
        vm.expectRevert(bytes("already registered"));
        hook.register(bot2, WEIGHT, SIG, PROMPT, IVault.Tier.Chat);
    }

    function test_burnIsIrreversible() public {
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Chat);
        vault.burn(BOT);
        vm.expectRevert(bytes("bot not active"));
        vault.grantAccess(BOT, 1);
        vm.expectRevert(bytes("not active"));
        vault.burn(BOT);
        vm.expectRevert(bytes("already registered"));
        vault.register(BOT, WEIGHT, SIG, PROMPT, Vault.Tier.Critical);
    }
}
