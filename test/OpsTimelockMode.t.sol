// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { OpsLive } from "../script/OpsLive.sol";
import { OpsDenylistAddExact } from "../script/OpsDenylist.s.sol";
import { DeployBotAttestationEscrow } from "../script/DeployBotAttestationEscrow.s.sol";

contract OpsTimelockModeTest is Test {
    OpsDenylistAddExact internal op;
    DeployBotAttestationEscrow internal deploy;
    address internal core;

    function setUp() public {
        op = new OpsDenylistAddExact();
        deploy = new DeployBotAttestationEscrow();
        core = op.LIVE_TIMELOCK();
    }

    function test_newTimelockUnsetReverts() public {
        Denylist denylist = new Denylist();
        op.useNewTimelock(address(0));
        vm.expectRevert(bytes("OpsLive: NEW_TIMELOCK unset"));
        op.performOwnerCall(address(denylist), abi.encodeWithSelector(Denylist.addExact.selector, bytes32("id")));

        vm.expectRevert(bytes("DeployEscrow: NEW_TIMELOCK unset"));
        deploy.requireTimelock(address(this), address(0));
    }

    function test_calldataModeWhenOwnerIsTimelock() public {
        TimelockController timelock = _timelock();
        Denylist denylist = new Denylist();
        denylist.transferOwnership(address(timelock));
        vm.prank(address(timelock));
        denylist.acceptOwnership();
        assertEq(denylist.owner(), address(timelock));

        bytes32 id = keccak256("listed");
        bytes memory inner = abi.encodeWithSelector(Denylist.addExact.selector, id);
        bytes32 salt = keccak256("salt");
        op.useNewTimelock(address(timelock));
        op.useSalt(salt);

        bool sent = op.performOwnerCall(address(denylist), inner);
        assertFalse(sent);
        assertFalse(denylist.listing(uint8(Denylist.Bucket.Exact), id).active);

        OpsLive.TimelockCall memory call = op.timelockCalldata(address(timelock), address(denylist), inner, salt);
        _assertSchedule(call, address(denylist), inner, salt, timelock.getMinDelay());
        _assertExecute(call, address(denylist), inner, salt);
        assertEq(call.operationId, timelock.hashOperation(address(denylist), 0, inner, bytes32(0), salt));
        assertEq(op.resolveSalt(address(denylist), inner), salt);
    }

    function test_legacyModeOnlyWhileOwnerIsCore() public {
        Denylist denylist = new Denylist();
        denylist.transferOwnership(core);
        vm.prank(core);
        denylist.acceptOwnership();
        assertEq(denylist.owner(), core);

        TimelockController timelock = _timelock();
        op.useNewTimelock(address(timelock));
        bytes32 id = keccak256("legacy");
        bytes memory inner = abi.encodeWithSelector(Denylist.addExact.selector, id);
        assertFalse(op.timelockMode(denylist.owner(), address(timelock)));

        bool sent = op.performOwnerCall(address(denylist), inner);
        assertTrue(sent);
        assertTrue(denylist.listing(uint8(Denylist.Bucket.Exact), id).active);
        assertEq(denylist.listing(uint8(Denylist.Bucket.Exact), id).lastListedBy, core);
    }

    function test_revertsWhenOwnerMatchesNeither() public {
        Denylist denylist = new Denylist();
        TimelockController timelock = _timelock();
        address owner = denylist.owner();
        op.useNewTimelock(address(timelock));
        vm.expectRevert(bytes("OpsLive: owner is neither NEW_TIMELOCK nor pre-migration CORE"));
        op.timelockMode(owner, address(timelock));
        vm.expectRevert(bytes("OpsLive: owner is neither NEW_TIMELOCK nor pre-migration CORE"));
        op.performOwnerCall(address(denylist), abi.encodeWithSelector(Denylist.addExact.selector, bytes32("nope")));
        assertFalse(denylist.listing(uint8(Denylist.Bucket.Exact), bytes32("nope")).active);
    }

    function test_saltDefaultsWhenUnset() public {
        op.useDefaultSalt();
        bytes memory data = hex"1234";
        address target = address(0xBEEF);
        assertEq(op.resolveSalt(target, data), keccak256(abi.encode(op.SALT_TAG(), target, data)));
        assertEq(op.SALT_REPEAT_HINT(), "set TIMELOCK_SALT to a fresh value to repeat an identical call");
    }

    function test_repeatedAddRevertsUntilSaltChanges() public {
        address[] memory proposers = new address[](1);
        proposers[0] = address(this);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController timelock = new TimelockController(300, proposers, executors, address(0));

        Denylist denylist = new Denylist();
        denylist.transferOwnership(address(timelock));
        vm.prank(address(timelock));
        denylist.acceptOwnership();

        bytes32 id = keccak256("again");
        bytes memory addData = abi.encodeWithSelector(Denylist.addExact.selector, id);
        bytes memory removeData = abi.encodeWithSelector(Denylist.remove.selector, id, uint8(Denylist.Bucket.Exact));
        op.useDefaultSalt();
        bytes32 salt = op.resolveSalt(address(denylist), addData);
        _scheduleAndExecute(timelock, address(denylist), addData, salt);
        assertTrue(denylist.listing(uint8(Denylist.Bucket.Exact), id).active);

        bytes32 removeSalt = op.resolveSalt(address(denylist), removeData);
        _scheduleAndExecute(timelock, address(denylist), removeData, removeSalt);
        assertFalse(denylist.listing(uint8(Denylist.Bucket.Exact), id).active);
        assertTrue(timelock.isOperationDone(timelock.hashOperation(address(denylist), 0, addData, bytes32(0), salt)));

        vm.expectRevert(bytes(string.concat("OpsLive: operation already exists; ", op.SALT_REPEAT_HINT())));
        op.timelockCalldata(address(timelock), address(denylist), addData, salt);

        bytes32 fresh = keccak256("fresh-salt");
        op.useSalt(fresh);
        OpsLive.TimelockCall memory again = op.timelockCalldata(address(timelock), address(denylist), addData, fresh);
        assertEq(again.salt, fresh);
        assertFalse(timelock.isOperation(again.operationId));
        timelock.schedule(address(denylist), 0, addData, bytes32(0), fresh, timelock.getMinDelay());
        assertTrue(timelock.isOperationPending(again.operationId));
    }

    function _assertSchedule(
        OpsLive.TimelockCall memory call,
        address expectedTarget,
        bytes memory inner,
        bytes32 salt,
        uint256 minDelay
    ) internal pure {
        assertEq(_selector(call.scheduleCalldata), TimelockController.schedule.selector);
        (address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 decodedSalt, uint256 delay) =
            abi.decode(_args(call.scheduleCalldata), (address, uint256, bytes, bytes32, bytes32, uint256));
        assertEq(target, expectedTarget);
        assertEq(value, 0);
        assertEq(data, inner);
        assertEq(predecessor, bytes32(0));
        assertEq(decodedSalt, salt);
        assertEq(delay, minDelay);
        assertEq(delay, 300);
    }

    function _assertExecute(
        OpsLive.TimelockCall memory call,
        address expectedTarget,
        bytes memory inner,
        bytes32 salt
    ) internal pure {
        assertEq(_selector(call.executeCalldata), TimelockController.execute.selector);
        (address target, uint256 value, bytes memory data, bytes32 predecessor, bytes32 decodedSalt) =
            abi.decode(_args(call.executeCalldata), (address, uint256, bytes, bytes32, bytes32));
        assertEq(target, expectedTarget);
        assertEq(value, 0);
        assertEq(data, inner);
        assertEq(predecessor, bytes32(0));
        assertEq(decodedSalt, salt);
    }

    function _selector(
        bytes memory blob
    ) internal pure returns (bytes4 sel) {
        assembly {
            sel := mload(add(blob, 32))
        }
    }

    function _scheduleAndExecute(
        TimelockController timelock,
        address target,
        bytes memory data,
        bytes32 salt
    ) internal {
        uint256 delay = timelock.getMinDelay();
        timelock.schedule(target, 0, data, bytes32(0), salt, delay);
        vm.warp(block.timestamp + delay);
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    function _timelock() internal returns (TimelockController) {
        address[] memory proposers = new address[](0);
        address[] memory executors = new address[](0);
        return new TimelockController(300, proposers, executors, address(0));
    }

    function _args(
        bytes memory blob
    ) internal pure returns (bytes memory args) {
        args = new bytes(blob.length - 4);
        for (uint256 i = 0; i < args.length; i++) {
            args[i] = blob[i + 4];
        }
    }
}
