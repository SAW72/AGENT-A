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
        vm.setEnv("NEW_TIMELOCK", "");
        Denylist denylist = new Denylist();
        vm.expectRevert(bytes("OpsLive: NEW_TIMELOCK unset"));
        op.performOwnerCall(address(denylist), abi.encodeWithSelector(Denylist.addExact.selector, bytes32("id")));

        vm.expectRevert(bytes("DeployEscrow: NEW_TIMELOCK unset"));
        deploy.readAddress("NEW_TIMELOCK", "DeployEscrow: NEW_TIMELOCK unset");
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
        vm.setEnv("NEW_TIMELOCK", vm.toString(address(timelock)));
        vm.setEnv("TIMELOCK_SALT", vm.toString(salt));

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
        vm.setEnv("NEW_TIMELOCK", vm.toString(address(timelock)));
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
        vm.setEnv("NEW_TIMELOCK", vm.toString(address(timelock)));
        vm.expectRevert(bytes("OpsLive: owner is neither NEW_TIMELOCK nor pre-migration CORE"));
        op.timelockMode(owner, address(timelock));
        vm.expectRevert(bytes("OpsLive: owner is neither NEW_TIMELOCK nor pre-migration CORE"));
        op.performOwnerCall(address(denylist), abi.encodeWithSelector(Denylist.addExact.selector, bytes32("nope")));
        assertFalse(denylist.listing(uint8(Denylist.Bucket.Exact), bytes32("nope")).active);
    }

    function test_saltDefaultsWhenUnset() public {
        vm.setEnv("TIMELOCK_SALT", "");
        bytes memory data = hex"1234";
        address target = address(0xBEEF);
        assertEq(op.resolveSalt(target, data), keccak256(abi.encode(op.SALT_TAG(), target, data)));
        assertEq(op.SALT_REPEAT_HINT(), "set TIMELOCK_SALT to a fresh value to repeat an identical call");
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
