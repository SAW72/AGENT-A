// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { Vault } from "../contracts/Vault.sol";
import { InsuranceFund } from "../contracts/InsuranceFund.sol";
import { Liability } from "../contracts/Liability.sol";
import { DisputePanel } from "../contracts/DisputePanel.sol";
import { Deploy } from "../script/Deploy.s.sol";

contract SmokeTest is Test {
    Denylist internal denylist;
    Vault internal vault;
    InsuranceFund internal insurance;
    Liability internal liability;
    DisputePanel internal panel;

    function setUp() public {
        denylist = new Denylist();
        vault = new Vault(address(denylist));
        liability = new Liability(address(0));
        insurance = new InsuranceFund(address(liability));
        liability.bindInsurance(address(insurance));
        panel = new DisputePanel();
        panel.setArbitrator(address(this), true);
        panel.setArbitrator(address(0x1), true);
        panel.setArbitrator(address(0x2), true);
    }

    function test_deployOrderWiresDependencies() public view {
        assertEq(denylist.owner(), address(this));
        assertEq(address(vault.denylist()), address(denylist));
        assertEq(address(liability.insurance()), address(insurance));
        assertEq(insurance.liability(), address(liability));
        assertEq(insurance.owner(), address(this));
        assertEq(panel.owner(), address(this));
    }

    function test_denylistAddAndCheck() public {
        bytes32 weight = keccak256("weight");
        bytes32 sig = keccak256("sig");
        bytes32 prompt = keccak256("prompt");
        denylist.addExact(weight);
        assertTrue(denylist.denylistedHashes(weight));
        Denylist.MatchLevel level = denylist.check(weight, sig, prompt);
        assertEq(uint256(level), uint256(Denylist.MatchLevel.ExactBlock));
    }

    function test_denylistUnbanClearsCheckAndKeepsHistory() public {
        bytes32 weight = keccak256("weight");
        denylist.addExact(weight);
        denylist.remove(weight, uint8(Denylist.Bucket.Exact));
        assertFalse(denylist.denylistedHashes(weight));
        assertEq(uint256(denylist.check(weight, bytes32(0), bytes32(0))), uint256(Denylist.MatchLevel.None));
        assertTrue(denylist.everListed(uint8(Denylist.Bucket.Exact), weight));
    }

    function testFuzz_addRemovePreservesHistory(
        bytes32 h
    ) public {
        if (h == bytes32(0)) {
            vm.expectRevert(Denylist.ZeroId.selector);
            denylist.addExact(h);
            return;
        }
        denylist.addExact(h);
        assertTrue(denylist.denylistedHashes(h));
        vm.expectRevert(abi.encodeWithSelector(Denylist.AlreadyListed.selector, Denylist.Bucket.Exact, h));
        denylist.addExact(h);
        denylist.remove(h, uint8(Denylist.Bucket.Exact));
        assertFalse(denylist.denylistedHashes(h));
        assertTrue(denylist.everListed(uint8(Denylist.Bucket.Exact), h));
        assertEq(uint256(denylist.check(h, bytes32(0), bytes32(0))), uint256(Denylist.MatchLevel.None));
    }

    function test_vaultRegisterGrantAndBurn() public {
        bytes32 botId = keccak256("bot");
        vault.register(botId, keccak256("w"), keccak256("s"), keccak256("p"), Vault.Tier.Chat);
        (,,,, bool active,) = vault.bots(botId);
        assertTrue(active);
        assertEq(vault.operator(botId), address(0));
        assertTrue(vault.grantAccess(botId, 1));
        vault.setOperator(botId, address(this));
        assertEq(vault.operator(botId), address(this));
        vault.burn(botId);
        (,,,, active,) = vault.bots(botId);
        assertFalse(active);
    }

    function test_vaultRejectsDenylisted() public {
        bytes32 weight = keccak256("bad");
        denylist.addExact(weight);
        vm.expectRevert(bytes("bot is denylisted"));
        vault.register(keccak256("bot"), weight, keccak256("s"), keccak256("p"), Vault.Tier.Chat);
    }

    function test_insuranceFundAndLiabilityClaim() public {
        insurance.fund{ value: 1 ether }();
        assertEq(insurance.balance(), 1 ether);

        bytes32 claimId = keccak256("claim");
        bytes32 incident = keccak256("incident");
        address payable claimant = payable(address(0xBEEF));
        liability.fileClaim(claimId, keccak256("bot"), incident, claimant, 0.25 ether, Liability.Party.Insurance);
        liability.settle(claimId);
        (,,,,, bool paid,) = liability.claims(claimId);
        assertTrue(paid);
        assertEq(claimant.balance, 0.25 ether);
        assertEq(insurance.balance(), 0.75 ether);
    }

    function test_noDoubleClaimOnIncident() public {
        liability.fileClaim(
            keccak256("c1"), keccak256("bot"), keccak256("inc"), payable(address(this)), 1, Liability.Party.Owner
        );
        vm.expectRevert(bytes("incident already claimed"));
        liability.fileClaim(
            keccak256("c2"), keccak256("bot"), keccak256("inc"), payable(address(this)), 1, Liability.Party.Owner
        );
    }

    function test_disputeResolvesAfterThreeVotes() public {
        bytes32 disputeId = keccak256("d1");
        panel.openDispute(disputeId, keccak256("subject"), "false flag");
        panel.vote(disputeId, true);
        vm.prank(address(0x1));
        panel.vote(disputeId, true);
        vm.prank(address(0x2));
        panel.vote(disputeId, false);
        (,,,,, bool resolved, bool upheld,) = panel.disputes(disputeId);
        assertTrue(resolved);
        assertTrue(upheld);
    }

    function test_unauthorizedVoterRejected() public {
        bytes32 disputeId = keccak256("d-unauth");
        panel.openDispute(disputeId, keccak256("subject"), "false flag");
        vm.prank(address(0xBEEF));
        vm.expectRevert(bytes("not authorized"));
        panel.vote(disputeId, true);
    }

    function test_auditorSettleRevertsUntilSlashWired() public {
        bytes32 claimId = keccak256("auditor-claim");
        liability.fileClaim(
            claimId, keccak256("bot"), keccak256("aud-inc"), payable(address(0xBEEF)), 1, Liability.Party.Auditor
        );
        vm.expectRevert(bytes("Liability: auditor slash/escrow unset"));
        liability.settle(claimId);
        (,,,,, bool paid,) = liability.claims(claimId);
        assertFalse(paid);
    }

    function test_coreOwnershipHandoffToTimelock() public {
        address timelock = address(0x71C0);
        denylist.transferOwnership(timelock);
        vault.transferOwnership(timelock);
        assertEq(denylist.pendingOwner(), timelock);
        assertEq(vault.pendingOwner(), timelock);
        assertEq(denylist.owner(), address(this));
        assertEq(vault.owner(), address(this));
        vm.prank(timelock);
        denylist.acceptOwnership();
        vm.prank(timelock);
        vault.acceptOwnership();
        insurance.setOwner(timelock);
        liability.setOwner(timelock);
        panel.setOwner(timelock);
        assertEq(denylist.owner(), timelock);
        assertEq(vault.owner(), timelock);
        assertEq(insurance.owner(), timelock);
        assertEq(liability.owner(), timelock);
        assertEq(panel.owner(), timelock);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        denylist.addExact(keccak256("x"));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        vault.burn(keccak256("missing"));
    }

    function test_strangerCannotTakeOwnership() public {
        address bad = address(0xBAD);
        vm.prank(bad);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bad));
        denylist.transferOwnership(bad);
        vm.prank(bad);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bad));
        vault.transferOwnership(bad);
    }

    function test_deploySetsInsuranceOwnerAndOnlyLiabilityPays() public {
        address timelock = address(0x71C0);
        insurance.setOwner(timelock);
        assertEq(insurance.owner(), timelock);
        assertEq(insurance.liability(), address(liability));
        insurance.fund{ value: 1 ether }();
        uint256 before = insurance.balance();
        vm.prank(address(0xE1E));
        vm.expectRevert(bytes("not liability"));
        insurance.payout(payable(address(0xE1E)), before, keccak256("stranger-drain"));
        assertEq(insurance.balance(), before);
    }
}

contract DeployGuardTest is Test {
    Deploy internal deploy;

    function setUp() public {
        deploy = new Deploy();
    }

    function test_allowsBaseSepolia() public {
        vm.chainId(84532);
        deploy.requireAllowedChain();
    }

    function test_refusesMainnet() public {
        vm.chainId(1);
        vm.expectRevert(bytes("Deploy: mainnet forbidden"));
        deploy.requireAllowedChain();
    }

    function test_refusesEthSepoliaByDefault() public {
        vm.chainId(11155111);
        vm.expectRevert(bytes("Deploy: Base Sepolia (84532) only; see README to switch to ETH Sepolia (11155111)"));
        deploy.requireAllowedChain();
    }

    function test_refusesAnvil() public {
        vm.chainId(31337);
        vm.expectRevert(bytes("Deploy: Base Sepolia (84532) only; see README to switch to ETH Sepolia (11155111)"));
        deploy.requireAllowedChain();
    }

    function test_constantsDocumentEthSepolia() public view {
        assertEq(deploy.ETH_SEPOLIA_CHAIN_ID(), 11155111);
        assertEq(deploy.ALLOWED_CHAIN_ID(), 84532);
    }

    function test_timelockMustBeSetAndNotDeployer() public {
        address deployer = address(this);
        vm.expectRevert(bytes("Deploy: CORE_TIMELOCK unset"));
        deploy.requireTimelock(deployer, address(0));
        vm.expectRevert(bytes("Deploy: CORE_TIMELOCK must not be deployer"));
        deploy.requireTimelock(deployer, deployer);
        deploy.requireTimelock(deployer, address(0x71C0));
    }
}
