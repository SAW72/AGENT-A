// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { Vault } from "../contracts/Vault.sol";
import { DeployDenylist } from "../script/DeployDenylist.s.sol";
import { MigrateDenylistListings } from "../script/MigrateDenylistListings.s.sol";

/// @dev Pre-PR #10 shape: public bool mappings, no `listing()`.
contract LegacyDenylistStub {
    mapping(bytes32 => bool) public denylistedHashes;
    mapping(bytes32 => bool) public denylistedSignatures;
    mapping(bytes32 => bool) public denylistedPrompts;

    function setHash(
        bytes32 id,
        bool active
    ) external {
        denylistedHashes[id] = active;
    }

    function setSignature(
        bytes32 id,
        bool active
    ) external {
        denylistedSignatures[id] = active;
    }

    function setPrompt(
        bytes32 id,
        bool active
    ) external {
        denylistedPrompts[id] = active;
    }
}

contract DeployDenylistGuardTest is Test {
    DeployDenylist internal deploy;

    function setUp() public {
        deploy = new DeployDenylist();
    }

    function test_allowsBaseSepolia() public {
        vm.chainId(84532);
        deploy.requireAllowedChain();
    }

    function test_refusesMainnet() public {
        vm.chainId(1);
        vm.expectRevert(bytes("DeployDenylist: mainnet forbidden"));
        deploy.requireAllowedChain();
    }

    function test_refusesEthSepoliaByDefault() public {
        vm.chainId(11155111);
        vm.expectRevert(
            bytes("DeployDenylist: Base Sepolia (84532) only; see README to switch to ETH Sepolia (11155111)")
        );
        deploy.requireAllowedChain();
    }

    function test_refusesAnvil() public {
        vm.chainId(31337);
        vm.expectRevert(
            bytes("DeployDenylist: Base Sepolia (84532) only; see README to switch to ETH Sepolia (11155111)")
        );
        deploy.requireAllowedChain();
    }

    function test_constantsDocumentEthSepolia() public view {
        assertEq(deploy.ETH_SEPOLIA_CHAIN_ID(), 11155111);
        assertEq(deploy.ALLOWED_CHAIN_ID(), 84532);
        assertEq(deploy.ETH_MAINNET_CHAIN_ID(), 1);
        assertEq(deploy.BASE_SEPOLIA_CHAIN_ID(), 84532);
    }

    function test_timelockMustBeSetAndNotDeployer() public {
        address deployer = address(this);
        vm.expectRevert(bytes("DeployDenylist: CORE_TIMELOCK unset"));
        deploy.requireTimelock(deployer, address(0));
        vm.expectRevert(bytes("DeployDenylist: CORE_TIMELOCK must not be deployer"));
        deploy.requireTimelock(deployer, deployer);
        deploy.requireTimelock(deployer, address(0x71C0));
    }

    function test_deployScriptDoesNotReferenceLiveDenylist() public view {
        string memory src = vm.readFile("script/DeployDenylist.s.sol");
        assertFalse(vm.contains(src, "F0f260967D377E07Bdd7840862508ddB23C012b8"));
        assertFalse(vm.contains(src, "f0f260967d377e07bdd7840862508ddb23c012b8"));
    }

    function test_deployWiresNewVaultAndStartsHandoff() public {
        address timelock = address(0x71C0);
        (Denylist denylist, Vault vault) = deploy.deploy(address(deploy), timelock);

        assertEq(address(vault.denylist()), address(denylist));
        assertEq(denylist.owner(), address(deploy));
        assertEq(denylist.pendingOwner(), timelock);
        assertEq(vault.owner(), address(deploy));
        assertEq(vault.pendingOwner(), timelock);
        assertTrue(address(denylist) != address(vault));
    }
}

contract MigrateDenylistListingsTest is Test {
    DeployDenylist internal deployer;
    MigrateDenylistListings internal migrate;
    LegacyDenylistStub internal oldDenylist;
    /// @dev `applyPending` calls `add*` as the script. Broadcast rewrites that sender to
    /// `CORE_TIMELOCK`. These tests use the script address as that owner.
    address internal timelock;

    bytes32 internal exactId = keccak256("exact");
    bytes32 internal signatureId = keccak256("signature");
    bytes32 internal promptId = keccak256("prompt");

    function setUp() public {
        deployer = new DeployDenylist();
        migrate = new MigrateDenylistListings();
        oldDenylist = new LegacyDenylistStub();
        timelock = address(migrate);
    }

    function test_chainGuards() public {
        vm.chainId(84532);
        migrate.requireAllowedChain();

        vm.chainId(1);
        vm.expectRevert(bytes("MigrateDenylist: mainnet forbidden"));
        migrate.requireAllowedChain();

        vm.chainId(11155111);
        vm.expectRevert(
            bytes("MigrateDenylist: Base Sepolia (84532) only; see README to switch to ETH Sepolia (11155111)")
        );
        migrate.requireAllowedChain();

        vm.chainId(31337);
        vm.expectRevert(
            bytes("MigrateDenylist: Base Sepolia (84532) only; see README to switch to ETH Sepolia (11155111)")
        );
        migrate.requireAllowedChain();
    }

    function test_templateFileIsEmpty() public {
        Denylist denylist = _acceptedDenylist();
        MigrateDenylistListings.Migration memory listed =
            migrate.loadMigration("script/denylist-migration.template.json");
        assertEq(listed.exact.length, 0);
        assertEq(listed.signature.length, 0);
        assertEq(listed.prompt.length, 0);

        MigrateDenylistListings.Migration memory pending =
            migrate.plan(address(denylist), address(oldDenylist), timelock, listed);
        assertEq(pending.exact.length, 0);
        assertEq(pending.signature.length, 0);
        assertEq(pending.prompt.length, 0);
    }

    function test_planAndApplyReplayActiveIdsOnly() public {
        (Denylist denylist, Vault vault) = _acceptedPair();
        oldDenylist.setHash(exactId, true);
        oldDenylist.setSignature(signatureId, true);
        oldDenylist.setPrompt(promptId, true);

        MigrateDenylistListings.Migration memory listed = _load(exactId, signatureId, promptId);
        MigrateDenylistListings.Migration memory pending =
            migrate.plan(address(denylist), address(oldDenylist), timelock, listed);
        assertEq(pending.exact.length, 1);
        assertEq(pending.exact[0], exactId);
        assertEq(pending.signature[0], signatureId);
        assertEq(pending.prompt[0], promptId);

        migrate.applyPending(denylist, pending);

        assertTrue(denylist.denylistedHashes(exactId));
        assertTrue(denylist.denylistedSignatures(signatureId));
        assertTrue(denylist.denylistedPrompts(promptId));
        assertTrue(denylist.everListed(Denylist.Bucket.Exact, exactId));
        Denylist.Listing memory row = denylist.listing(Denylist.Bucket.Exact, exactId);
        assertTrue(row.active);
        assertEq(row.timesListed, 1);
        assertEq(row.lastListedBy, timelock);
        assertTrue(oldDenylist.denylistedHashes(exactId));
        assertEq(uint256(denylist.check(exactId, signatureId, promptId)), uint256(Denylist.MatchLevel.ExactBlock));

        vm.prank(timelock);
        vm.expectRevert(bytes("bot is denylisted"));
        vault.register(keccak256("bot"), exactId, signatureId, promptId, Vault.Tier.Chat);
        vm.prank(timelock);
        vault.register(
            keccak256("ok"), keccak256("clean-w"), keccak256("clean-s"), keccak256("clean-p"), Vault.Tier.Chat
        );

        MigrateDenylistListings.Migration memory again =
            migrate.plan(address(denylist), address(oldDenylist), timelock, listed);
        assertEq(again.exact.length, 0);
        assertEq(again.signature.length, 0);
        assertEq(again.prompt.length, 0);
    }

    function test_sameIdMayOccupyTwoBuckets() public {
        Denylist denylist = _acceptedDenylist();
        oldDenylist.setHash(exactId, true);
        oldDenylist.setSignature(exactId, true);

        MigrateDenylistListings.Migration memory listed;
        listed.exact = new bytes32[](1);
        listed.exact[0] = exactId;
        listed.signature = new bytes32[](1);
        listed.signature[0] = exactId;
        listed.prompt = new bytes32[](0);

        MigrateDenylistListings.Migration memory pending =
            migrate.plan(address(denylist), address(oldDenylist), timelock, listed);
        migrate.applyPending(denylist, pending);
        assertTrue(denylist.denylistedHashes(exactId));
        assertTrue(denylist.denylistedSignatures(exactId));
    }

    function test_revertsWhenIdInactiveOnOld() public {
        Denylist denylist = _acceptedDenylist();
        MigrateDenylistListings.Migration memory listed = _load(exactId, signatureId, promptId);
        vm.expectRevert(bytes("MigrateDenylist: id not active on old denylist"));
        migrate.plan(address(denylist), address(oldDenylist), timelock, listed);
    }

    function test_revertsOnZeroId() public {
        Denylist denylist = _acceptedDenylist();
        MigrateDenylistListings.Migration memory listed = _listed(bytes32(0), signatureId, promptId);
        vm.expectRevert(bytes("MigrateDenylist: zero id"));
        migrate.plan(address(denylist), address(oldDenylist), timelock, listed);
    }

    function test_revertsOnDuplicateWithinBucket() public {
        Denylist denylist = _acceptedDenylist();
        oldDenylist.setHash(exactId, true);
        MigrateDenylistListings.Migration memory listed;
        listed.exact = new bytes32[](2);
        listed.exact[0] = exactId;
        listed.exact[1] = exactId;
        listed.signature = new bytes32[](0);
        listed.prompt = new bytes32[](0);
        vm.expectRevert(bytes("MigrateDenylist: duplicate id"));
        migrate.plan(address(denylist), address(oldDenylist), timelock, listed);
    }

    function test_duplicateStillRevertsWhenAlreadyActive() public {
        Denylist denylist = _acceptedDenylist();
        oldDenylist.setHash(exactId, true);
        vm.prank(timelock);
        denylist.addExact(exactId);

        MigrateDenylistListings.Migration memory listed;
        listed.exact = new bytes32[](2);
        listed.exact[0] = exactId;
        listed.exact[1] = exactId;
        listed.signature = new bytes32[](0);
        listed.prompt = new bytes32[](0);
        vm.expectRevert(bytes("MigrateDenylist: duplicate id"));
        migrate.plan(address(denylist), address(oldDenylist), timelock, listed);
    }

    function test_refusesOldEqualNew() public {
        Denylist denylist = _acceptedDenylist();
        vm.expectRevert(bytes("MigrateDenylist: old and new must differ"));
        migrate.preflight(address(denylist), address(denylist), timelock);
    }

    function test_refusesLiveDenylistAsNew() public {
        address live = migrate.LIVE_PRE_PR10_DENYLIST();
        vm.expectRevert(bytes("MigrateDenylist: refusing live pre-PR10 Denylist"));
        migrate.preflight(live, address(oldDenylist), timelock);
    }

    function test_applyPendingRefusesLiveDenylist() public {
        address live = migrate.LIVE_PRE_PR10_DENYLIST();
        MigrateDenylistListings.Migration memory pending;
        pending.exact = new bytes32[](0);
        pending.signature = new bytes32[](0);
        pending.prompt = new bytes32[](0);
        vm.expectRevert(bytes("MigrateDenylist: refusing live pre-PR10 Denylist"));
        migrate.applyPending(Denylist(live), pending);
    }

    function test_refusesLegacyBytecodeAsNew() public {
        LegacyDenylistStub other = new LegacyDenylistStub();
        vm.expectRevert(bytes("MigrateDenylist: NEW_DENYLIST is not tip Denylist"));
        migrate.preflight(address(oldDenylist), address(other), timelock);
    }

    function test_refusesBeforeAcceptOwnership() public {
        (Denylist denylist,) = deployer.deploy(address(deployer), timelock);
        assertEq(denylist.pendingOwner(), timelock);
        vm.expectRevert(bytes("MigrateDenylist: owner is not CORE_TIMELOCK; acceptOwnership first"));
        migrate.preflight(address(denylist), address(oldDenylist), timelock);
    }

    function test_applyPendingRequiresOwner() public {
        address other = address(0x71C0);
        (Denylist denylist,) = deployer.deploy(address(deployer), other);
        vm.prank(other);
        denylist.acceptOwnership();
        oldDenylist.setHash(exactId, true);
        MigrateDenylistListings.Migration memory listed;
        listed.exact = new bytes32[](1);
        listed.exact[0] = exactId;
        listed.signature = new bytes32[](0);
        listed.prompt = new bytes32[](0);
        MigrateDenylistListings.Migration memory pending =
            migrate.plan(address(denylist), address(oldDenylist), other, listed);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(migrate)));
        migrate.applyPending(denylist, pending);
    }

    function test_runDryWhenSignerIsNotTimelock() public {
        Denylist denylist = _acceptedDenylist();
        oldDenylist.setHash(exactId, true);
        string memory path = _writeExact(exactId);

        uint256 signerKey = 0xA11CE;
        vm.chainId(84532);
        vm.setEnv("PRIVATE_KEY", vm.toString(signerKey));
        vm.setEnv("CORE_TIMELOCK", vm.toString(timelock));
        vm.setEnv("NEW_DENYLIST", vm.toString(address(denylist)));
        vm.setEnv("OLD_DENYLIST", vm.toString(address(oldDenylist)));
        vm.setEnv("MIGRATION_FILE", path);

        migrate.run();
        assertFalse(denylist.denylistedHashes(exactId));
        assertTrue(oldDenylist.denylistedHashes(exactId));
    }

    function test_runRevertsOnMainnetBeforeEnv() public {
        vm.chainId(1);
        vm.expectRevert(bytes("MigrateDenylist: mainnet forbidden"));
        migrate.run();
    }

    function test_preflightUnsetAddresses() public {
        Denylist denylist = _acceptedDenylist();
        vm.expectRevert(bytes("MigrateDenylist: CORE_TIMELOCK unset"));
        migrate.preflight(address(denylist), address(oldDenylist), address(0));
        vm.expectRevert(bytes("MigrateDenylist: NEW_DENYLIST unset"));
        migrate.preflight(address(0), address(oldDenylist), timelock);
        vm.expectRevert(bytes("MigrateDenylist: OLD_DENYLIST unset"));
        migrate.preflight(address(denylist), address(0), timelock);
    }

    function _acceptedDenylist() internal returns (Denylist denylist) {
        (denylist,) = _acceptedPair();
    }

    function _acceptedPair() internal returns (Denylist denylist, Vault vault) {
        (denylist, vault) = deployer.deploy(address(deployer), timelock);
        vm.startPrank(timelock);
        denylist.acceptOwnership();
        vault.acceptOwnership();
        vm.stopPrank();
        assertEq(denylist.owner(), timelock);
        assertEq(denylist.pendingOwner(), address(0));
        assertEq(vault.owner(), timelock);
        assertEq(address(vault.denylist()), address(denylist));
    }

    function _listed(
        bytes32 exact,
        bytes32 signature,
        bytes32 prompt
    ) internal pure returns (MigrateDenylistListings.Migration memory listed) {
        listed.exact = new bytes32[](1);
        listed.exact[0] = exact;
        listed.signature = new bytes32[](1);
        listed.signature[0] = signature;
        listed.prompt = new bytes32[](1);
        listed.prompt[0] = prompt;
    }

    function _load(
        bytes32 exact,
        bytes32 signature,
        bytes32 prompt
    ) internal returns (MigrateDenylistListings.Migration memory listed) {
        listed = migrate.loadMigration(_writeListed(exact, signature, prompt));
    }

    function _writeListed(
        bytes32 exact,
        bytes32 signature,
        bytes32 prompt
    ) internal returns (string memory path) {
        path = string.concat("out/denylist-mig-", vm.toString(vm.randomUint()), ".json");
        vm.writeFile(
            path,
            string.concat(
                '{"exact":["',
                vm.toString(exact),
                '"],"signature":["',
                vm.toString(signature),
                '"],"prompt":["',
                vm.toString(prompt),
                '"]}'
            )
        );
    }

    function _writeExact(
        bytes32 exact
    ) internal returns (string memory path) {
        path = string.concat("out/denylist-mig-", vm.toString(vm.randomUint()), ".json");
        vm.writeFile(path, string.concat('{"exact":["', vm.toString(exact), '"],"signature":[],"prompt":[]}'));
    }
}
