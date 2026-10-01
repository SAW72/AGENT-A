// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { DeployTimelock } from "../script/DeployTimelock.s.sol";
import { MigrateOwnershipToTimelock } from "../script/MigrateOwnershipToTimelock.s.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { Vault } from "../contracts/Vault.sol";
import { Liability } from "../contracts/Liability.sol";
import { InsuranceFund } from "../contracts/InsuranceFund.sol";
import { DisputePanel } from "../contracts/DisputePanel.sol";
import { BotAttestationEscrow } from "../contracts/BotAttestationEscrow.sol";

contract CoreTimelockTest is Test {
    DeployTimelock internal deploy;
    MigrateOwnershipToTimelock internal mig;

    Denylist internal denylist;
    Vault internal vault;
    Liability internal liability;
    InsuranceFund internal insurance;
    DisputePanel internal panel;
    BotAttestationEscrow internal escrow;
    Denylist internal oldDenylist;
    Vault internal oldVault;
    BotAttestationEscrow internal retired;

    function setUp() public {
        deploy = new DeployTimelock();
        mig = new MigrateOwnershipToTimelock();
    }

    function test_delayIsEnforced() public {
        (TimelockController tl, address safe) = _controller(300, address(0));
        bytes memory payload = abi.encodeCall(TimelockController.updateDelay, (300));
        bytes32 salt = bytes32(uint256(1));
        bytes32 predecessor = bytes32(0);

        vm.prank(safe);
        tl.schedule(address(tl), 0, payload, predecessor, salt, 300);

        bytes32 id = tl.hashOperation(address(tl), 0, payload, predecessor, salt);
        bytes32 ready = bytes32(uint256(1) << 2);
        assertFalse(tl.isOperationReady(id));

        vm.expectRevert(abi.encodeWithSignature("TimelockUnexpectedOperationState(bytes32,bytes32)", id, ready));
        tl.execute(address(tl), 0, payload, predecessor, salt);

        vm.warp(block.timestamp + 300);
        assertTrue(tl.isOperationReady(id));
        tl.execute(address(tl), 0, payload, predecessor, salt);
        assertTrue(tl.isOperationDone(id));
        assertEq(tl.getMinDelay(), 300);
    }

    function test_onlySafeCanProposeAndCancel() public {
        (TimelockController tl, address safe) = _controller(300, address(0));
        address stranger = makeAddr("stranger");
        bytes memory payload = abi.encodeCall(TimelockController.updateDelay, (300));
        bytes32 salt = bytes32(uint256(2));
        bytes32 predecessor = bytes32(0);

        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", stranger, tl.PROPOSER_ROLE())
        );
        tl.schedule(address(tl), 0, payload, predecessor, salt, 300);
        vm.stopPrank();

        vm.prank(safe);
        tl.schedule(address(tl), 0, payload, predecessor, salt, 300);
        bytes32 id = tl.hashOperation(address(tl), 0, payload, predecessor, salt);

        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", stranger, tl.CANCELLER_ROLE())
        );
        tl.cancel(id);
        vm.stopPrank();

        vm.prank(safe);
        tl.cancel(id);
        assertFalse(tl.isOperation(id));

        bytes32 ready = bytes32(uint256(1) << 2);
        vm.expectRevert(abi.encodeWithSignature("TimelockUnexpectedOperationState(bytes32,bytes32)", id, ready));
        tl.execute(address(tl), 0, payload, predecessor, salt);
    }

    function test_safeExecutorRejectsStrangers() public {
        address safe = _etchSafe();
        (TimelockController tl,) = _controllerWith(safe, 300, safe);
        bytes memory payload = abi.encodeCall(TimelockController.updateDelay, (300));
        bytes32 salt = bytes32(uint256(3));
        vm.prank(safe);
        tl.schedule(address(tl), 0, payload, bytes32(0), salt, 300);
        vm.warp(block.timestamp + 300);

        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", stranger, tl.EXECUTOR_ROLE())
        );
        tl.execute(address(tl), 0, payload, bytes32(0), salt);
        vm.stopPrank();

        vm.prank(safe);
        tl.execute(address(tl), 0, payload, bytes32(0), salt);
        assertTrue(tl.isOperationDone(tl.hashOperation(address(tl), 0, payload, bytes32(0), salt)));
    }

    function test_adminRoleIsNotHeldByAnEoa() public {
        address eoa = makeAddr("deployer");
        address safe = _etchSafe();
        address other = makeAddr("other");
        vm.prank(eoa);
        TimelockController tl = deploy.deployTimelock(safe, 300, address(0));

        bytes32 admin = tl.DEFAULT_ADMIN_ROLE();
        assertTrue(tl.hasRole(admin, address(tl)));
        assertFalse(tl.hasRole(admin, eoa));
        assertFalse(tl.hasRole(admin, other));
        assertFalse(tl.hasRole(admin, safe));
        assertFalse(tl.hasRole(admin, address(0)));
        assertFalse(tl.hasRole(admin, mig.CORE_TIMELOCK()));
        assertFalse(tl.hasRole(admin, tx.origin));
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), safe));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), safe));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), address(0)));
        assertEq(tl.getMinDelay(), 300);
    }

    function test_safeWithoutCodeReverts() public {
        vm.expectRevert(bytes("DeployTimelock: SAFE_ADDRESS has no code"));
        deploy.deployTimelock(makeAddr("bare"), 300, address(0));
    }

    function test_chainGuardAndShortDelayWarning() public {
        vm.chainId(84532);
        deploy.requireAllowedChain();
        vm.chainId(31337);
        deploy.requireAllowedChain();
        deploy.noteShortDelay(300);
        assertFalse(deploy.shortDelayWarned());

        vm.chainId(8453);
        vm.expectRevert(bytes("DeployTimelock: chain refused; only 84532 or 31337 unless ALLOW_MAINNET=1"));
        deploy.requireAllowedChain();
        vm.chainId(11155111);
        vm.expectRevert(bytes("DeployTimelock: chain refused; only 84532 or 31337 unless ALLOW_MAINNET=1"));
        deploy.requireAllowedChain();
        vm.chainId(1);
        vm.expectRevert(bytes("MigrateOwnership: mainnet refused; set ALLOW_MAINNET=1"));
        mig.requireAllowedChain();

        vm.setEnv("ALLOW_MAINNET", "1");
        vm.chainId(8453);
        deploy.requireAllowedChain();
        mig.requireAllowedChain();
        deploy.noteShortDelay(300);
        assertTrue(deploy.shortDelayWarned());
        deploy.noteShortDelay(48 hours);
        assertFalse(deploy.shortDelayWarned());

        address foundryDefault = deploy.FOUNDRY_DEFAULT_SENDER();
        address simulateSender = deploy.SIMULATE_SENDER();
        address keystore = makeAddr("keystore");
        address core = mig.CORE_TIMELOCK();
        vm.expectRevert(bytes("DeployTimelock: pass --account and --sender"));
        deploy.requireBroadcastSender(foundryDefault);
        vm.expectRevert(bytes("DeployTimelock: pass --account and --sender"));
        deploy.requireBroadcastSender(simulateSender);
        deploy.requireBroadcastSender(keystore);

        vm.expectRevert(bytes("MigrateOwnership: sender must be CORE_TIMELOCK"));
        mig.requireBroadcastSender(keystore);
        mig.requireBroadcastSender(core);

        vm.expectRevert(bytes("DeployTimelock: TIMELOCK_MIN_DELAY unset"));
        deploy.readMinDelay();
    }

    function test_bookParsesDeploymentJson() public view {
        (string[] memory names, address[] memory targets) = mig.bookEntries();
        assertEq(targets.length, 14);
        assertEq(names[0], "Denylist");
        assertEq(targets[0], 0xeE76876bECcFc1B58fC06fF4E654a517d784B224);
        assertEq(targets[1], 0x1463D664fA467FBCDA4B05443434494f05e565bc);
        assertEq(targets[2], 0x554Caf5a214B8d70D675C09186C5EAE24FEB7307);
        assertEq(targets[3], 0x19fc26B36Cb2031062eD90C19db64b3b09753ab8);
        assertEq(targets[4], 0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb);
        assertEq(targets[5], 0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d);
        assertEq(targets[6], address(0));
        assertEq(targets[7], address(0));
        assertEq(targets[8], address(0));
        assertEq(targets[9], address(0));
        assertEq(targets[10], address(0));
        assertEq(names[11], "superseded.Denylist");
        assertEq(targets[11], 0xF0f260967D377E07Bdd7840862508ddB23C012b8);
        assertEq(targets[12], 0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7);
        assertEq(names[13], "retired.BotAttestationEscrow");
        assertEq(targets[13], 0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c);
    }

    function test_scriptedFlowLandsOwnershipOnTimelock() public {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        (TimelockController tl, address safe) = _controller(300, address(0));
        vm.setEnv("SAFE_ADDRESS", vm.toString(safe));

        MigrateOwnershipToTimelock.TransferResult memory first = mig.transferAll(targets, address(tl));
        assertEq(first.immediate, 3);
        assertEq(first.twoStepQueued, 3);
        assertEq(first.pendingThenQueued, 1);
        assertEq(first.skipped, 2);

        assertEq(liability.owner(), address(tl));
        assertEq(insurance.owner(), address(tl));
        assertEq(panel.owner(), address(tl));
        assertEq(denylist.owner(), core);
        assertEq(denylist.pendingOwner(), address(tl));
        assertEq(oldVault.owner(), core);
        assertEq(oldVault.pendingOwner(), address(tl));
        assertEq(escrow.owner(), core);
        assertEq(escrow.pendingOwner(), address(0));
        assertEq(retired.owner(), core);
        assertEq(retired.pendingOwner(), address(0));
        assertEq(escrow.governance(), core);
        assertEq(retired.governance(), core);

        vm.expectRevert(bytes("MigrateOwnership: CORE_TIMELOCK still owns"));
        mig.postCheck(targets, address(tl));

        (
            address[] memory batchTargets,
            uint256[] memory values,
            bytes[] memory payloads,
            bytes32 predecessor,
            bytes32 salt
        ) = mig.collectAccept(targets, address(tl));
        assertEq(batchTargets.length, 4);
        assertEq(predecessor, bytes32(0));
        assertEq(salt, mig.ACCEPT_SALT());
        assertEq(bytes4(payloads[0]), bytes4(keccak256("acceptOwnership()")));

        vm.prank(safe);
        tl.scheduleBatch(batchTargets, values, payloads, predecessor, salt, 300);

        bytes32 id = tl.hashOperationBatch(batchTargets, values, payloads, predecessor, salt);
        bytes32 ready = bytes32(uint256(1) << 2);
        vm.expectRevert(abi.encodeWithSignature("TimelockUnexpectedOperationState(bytes32,bytes32)", id, ready));
        tl.executeBatch(batchTargets, values, payloads, predecessor, salt);

        vm.warp(block.timestamp + 300);
        tl.executeBatch(batchTargets, values, payloads, predecessor, salt);

        mig.postCheck(targets, address(tl));
        assertEq(denylist.owner(), address(tl));
        assertEq(denylist.pendingOwner(), address(0));
        assertEq(vault.owner(), address(tl));
        assertEq(vault.pendingOwner(), address(0));
        assertEq(oldDenylist.owner(), address(tl));
        assertEq(oldVault.owner(), address(tl));
        assertEq(oldVault.pendingOwner(), address(0));
        assertEq(escrow.owner(), core);
        assertEq(escrow.pendingOwner(), address(0));
        assertEq(retired.owner(), core);
        assertEq(retired.pendingOwner(), address(0));
        assertEq(escrow.governance(), core);
        assertEq(retired.governance(), core);

        MigrateOwnershipToTimelock.TransferResult memory done = mig.transferAll(targets, address(tl));
        assertEq(done.immediate, 0);
        assertEq(done.twoStepQueued, 0);
        assertEq(done.pendingThenQueued, 0);
        assertEq(done.skipped, targets.length);
        assertEq(denylist.owner(), address(tl));
        assertEq(liability.owner(), address(tl));
    }

    function test_migrationIsIdempotent() public {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        (TimelockController tl, address safe) = _controller(300, address(0));
        vm.setEnv("SAFE_ADDRESS", vm.toString(safe));

        mig.transferAll(targets, address(tl));
        assertEq(escrow.owner(), core);
        assertEq(retired.owner(), core);
        address[] memory owners = new address[](targets.length);
        address[] memory pendings = new address[](targets.length);
        for (uint256 i = 0; i < targets.length; i++) {
            (, owners[i],, pendings[i]) = mig.inspect(targets[i]);
        }

        MigrateOwnershipToTimelock.TransferResult memory again = mig.transferAll(targets, address(tl));
        assertEq(again.immediate, 0);
        assertEq(again.twoStepQueued, 0);
        assertEq(again.pendingThenQueued, 0);
        assertEq(again.skipped, targets.length);
        for (uint256 i = 0; i < targets.length; i++) {
            (, address owner,, address pending) = mig.inspect(targets[i]);
            assertEq(owner, owners[i]);
            assertEq(pending, pendings[i]);
        }
        assertEq(escrow.owner(), core);
        assertEq(retired.owner(), core);
    }

    function test_escrowOptInMigratesAndPostCheckRequiresIt() public {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        (TimelockController tl, address safe) = _controller(300, address(0));
        vm.setEnv("SAFE_ADDRESS", vm.toString(safe));

        mig.transferAll(targets, address(tl));
        _acceptAll(tl, safe, targets);
        mig.postCheck(targets, address(tl));
        assertEq(escrow.owner(), core);
        assertEq(retired.owner(), core);

        mig.optInEscrows();
        assertTrue(mig.migrateEscrows());
        vm.expectRevert(bytes("MigrateOwnership: escrow owner is not the timelock"));
        mig.postCheck(targets, address(tl));

        MigrateOwnershipToTimelock.TransferResult memory queued = mig.transferAll(targets, address(tl));
        assertEq(queued.immediate, 0);
        assertEq(queued.twoStepQueued, 2);
        assertEq(queued.pendingThenQueued, 0);
        assertEq(escrow.owner(), core);
        assertEq(escrow.pendingOwner(), address(tl));
        assertEq(retired.pendingOwner(), address(tl));
        vm.expectRevert(bytes("MigrateOwnership: escrow owner is not the timelock"));
        mig.postCheck(targets, address(tl));

        MigrateOwnershipToTimelock.TransferResult memory again = mig.transferAll(targets, address(tl));
        assertEq(again.twoStepQueued, 0);
        assertEq(again.skipped, targets.length);
        assertEq(escrow.pendingOwner(), address(tl));

        _acceptAll(tl, safe, targets);
        mig.postCheck(targets, address(tl));
        assertEq(escrow.owner(), address(tl));
        assertEq(escrow.pendingOwner(), address(0));
        assertEq(retired.owner(), address(tl));
        assertEq(retired.pendingOwner(), address(0));
        assertEq(escrow.governance(), core);

        vm.expectRevert(BotAttestationEscrow.FundingBeforeGovernance.selector);
        escrow.createEscrow(keccak256("id"), address(0xBEEF), keccak256("payer"), keccak256("payee"), 1 days);

        MigrateOwnershipToTimelock.TransferResult memory done = mig.transferAll(targets, address(tl));
        assertEq(done.skipped, targets.length);
        assertEq(escrow.owner(), address(tl));
    }

    function test_badTimelockRevertsBeforeHandoff() public {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        address safe = _etchSafe();
        vm.setEnv("SAFE_ADDRESS", vm.toString(safe));
        address[] memory executors = new address[](1);

        address[] memory wrong = new address[](1);
        wrong[0] = makeAddr("otherProposer");
        TimelockController wrongProposer = new TimelockController(300, wrong, executors, address(0));
        vm.expectRevert(bytes("MigrateOwnership: SAFE missing PROPOSER_ROLE"));
        mig.transferAll(targets, address(wrongProposer));
        _assertUnchanged(targets, core);

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        TimelockController adminEoa = new TimelockController(300, proposers, executors, address(this));
        vm.expectRevert(bytes("MigrateOwnership: msg.sender holds DEFAULT_ADMIN_ROLE"));
        mig.transferAll(targets, address(adminEoa));
        _assertUnchanged(targets, core);

        TimelockController coreAdmin = new TimelockController(300, proposers, executors, core);
        vm.expectRevert(bytes("MigrateOwnership: CORE_TIMELOCK holds DEFAULT_ADMIN_ROLE"));
        mig.transferAll(targets, address(coreAdmin));
        _assertUnchanged(targets, core);

        TimelockController zeroDelay = new TimelockController(0, proposers, executors, address(0));
        vm.expectRevert(bytes("MigrateOwnership: minDelay is zero"));
        mig.transferAll(targets, address(zeroDelay));
        _assertUnchanged(targets, core);

        TimelockController stripped = new TimelockController(300, proposers, executors, address(this));
        stripped.revokeRole(stripped.DEFAULT_ADMIN_ROLE(), address(stripped));
        vm.expectRevert(bytes("MigrateOwnership: timelock is not self-administered"));
        mig.transferAll(targets, address(stripped));
        _assertUnchanged(targets, core);

        vm.setEnv("NEW_TIMELOCK", vm.toString(address(wrongProposer)));
        vm.setEnv("MIGRATION_STEP", "accept");
        vm.expectRevert(bytes("MigrateOwnership: SAFE missing PROPOSER_ROLE"));
        mig.run();
        _assertUnchanged(targets, core);
    }

    function _acceptAll(
        TimelockController tl,
        address safe,
        address[] memory targets
    ) internal {
        (
            address[] memory batchTargets,
            uint256[] memory values,
            bytes[] memory payloads,
            bytes32 predecessor,
            bytes32 salt
        ) = mig.collectAccept(targets, address(tl));
        uint256 delay = tl.getMinDelay();
        vm.prank(safe);
        tl.scheduleBatch(batchTargets, values, payloads, predecessor, salt, delay);
        vm.warp(block.timestamp + delay);
        tl.executeBatch(batchTargets, values, payloads, predecessor, salt);
    }

    function _assertUnchanged(
        address[] memory targets,
        address core
    ) internal view {
        for (uint256 i = 0; i < targets.length; i++) {
            (bool hasOwner, address owner, bool twoStep, address pending) = mig.inspect(targets[i]);
            assertTrue(hasOwner);
            if (targets[i] == address(oldVault)) {
                assertEq(owner, address(this));
                assertTrue(twoStep);
                assertEq(pending, core);
            } else {
                assertEq(owner, core);
                if (twoStep) assertEq(pending, address(0));
            }
        }
    }

    function _seed(
        address core
    ) internal returns (address[] memory targets) {
        denylist = new Denylist();
        vault = new Vault(address(denylist));
        liability = new Liability(address(0));
        insurance = new InsuranceFund(address(liability));
        liability.bindInsurance(address(insurance));
        panel = new DisputePanel();
        escrow = new BotAttestationEscrow(address(denylist), address(vault), address(panel), core);
        oldDenylist = new Denylist();
        oldVault = new Vault(address(oldDenylist));
        retired = new BotAttestationEscrow(address(denylist), address(vault), address(panel), core);

        denylist.transferOwnership(core);
        vault.transferOwnership(core);
        escrow.transferOwnership(core);
        oldDenylist.transferOwnership(core);
        retired.transferOwnership(core);
        oldVault.transferOwnership(core);

        vm.startPrank(core);
        denylist.acceptOwnership();
        vault.acceptOwnership();
        escrow.acceptOwnership();
        oldDenylist.acceptOwnership();
        retired.acceptOwnership();
        vm.stopPrank();

        liability.setOwner(core);
        insurance.setOwner(core);
        panel.setOwner(core);

        targets = new address[](9);
        targets[0] = address(denylist);
        targets[1] = address(vault);
        targets[2] = address(liability);
        targets[3] = address(insurance);
        targets[4] = address(panel);
        targets[5] = address(escrow);
        targets[6] = address(oldDenylist);
        targets[7] = address(oldVault);
        targets[8] = address(retired);
    }

    function _etchSafe() internal returns (address safe) {
        safe = makeAddr("safe");
        vm.etch(safe, hex"00");
    }

    function _controller(
        uint256 delay,
        address executor
    ) internal returns (TimelockController tl, address safe) {
        safe = _etchSafe();
        (tl,) = _controllerWith(safe, delay, executor);
    }

    function _controllerWith(
        address safe,
        uint256 delay,
        address executor
    ) internal returns (TimelockController tl, address safeOut) {
        address eoa = makeAddr("deployerEoa");
        vm.prank(eoa);
        tl = deploy.deployTimelock(safe, delay, executor);
        safeOut = safe;
    }
}

/// @notice Live Base Sepolia classification. Skips with no fork and no `BASE_SEPOLIA_RPC_URL`.
contract CoreTimelockForkTest is Test {
    address internal constant CORE = 0x10CC9474b45625ADfd05C209f2518023484878D9;
    address internal constant DEPLOYER = 0x5D467FA00eC0E92044f779e495a17db66c5964aa;
    uint256 internal constant BASE_SEPOLIA = 84532;

    MigrateOwnershipToTimelock internal mig;

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
        mig = new MigrateOwnershipToTimelock();
    }

    function test_forkClassifiesBookOwners() public view {
        assertEq(block.chainid, BASE_SEPOLIA);
        assertEq(CORE.code.length, 23);
        (bool delayOk,) = CORE.staticcall(abi.encodeWithSignature("getMinDelay()"));
        assertFalse(delayOk);

        (, address[] memory targets) = mig.bookEntries();
        address[9] memory owned = [
            targets[0], targets[1], targets[2], targets[3], targets[4], targets[5], targets[11], targets[13], address(0)
        ];
        for (uint256 i = 0; i < 8; i++) {
            (bool hasOwner, address owner, bool twoStep, address pending) = mig.inspect(owned[i]);
            assertTrue(hasOwner);
            assertEq(owner, CORE);
            assertEq(pending, address(0));
            if (i == 2 || i == 3 || i == 4) assertFalse(twoStep);
            else assertTrue(twoStep);
        }

        (bool oldHas, address oldOwner, bool oldTwo, address oldPending) = mig.inspect(targets[12]);
        assertTrue(oldHas);
        assertTrue(oldTwo);
        assertEq(oldOwner, DEPLOYER);
        assertEq(oldPending, CORE);

        assertEq(mig.governanceOf(targets[5]), CORE);
        assertEq(mig.governanceOf(targets[13]), CORE);
        assertFalse(mig.coreIsArbitrator(targets[4]));
        for (uint256 i = 6; i <= 10; i++) {
            assertEq(targets[i], address(0));
        }
    }
}
