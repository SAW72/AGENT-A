// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

interface ISafe {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @notice Deploy an OpenZeppelin `TimelockController` (v5.7.0, the version pinned in `foundry.lock`).
/// @dev Proposer is `SAFE_ADDRESS` only. OZ v5 grants that proposer `CANCELLER_ROLE` in the constructor.
///      `admin` is `address(0)`, so `DEFAULT_ADMIN_ROLE` stays on the timelock itself. No EOA is admin.
///      Broadcast is `vm.startBroadcast()` with no key. Foundry signs from `--account` / `--sender`.
///      This script never reads `PRIVATE_KEY`.
///      Chain ids 84532 (Base Sepolia) and 31337 (Anvil) are allowed. Chain ids 8453 and 1 also require
///      `ALLOW_MAINNET=1`. Every other chain reverts. Mainnet is not in scope.
///      `TIMELOCK_MIN_DELAY` must be at least 300 seconds on 84532 and 31337, and at least 48 hours on 8453 and 1.
///      `SAFE_ADDRESS` must be a Safe: not `CORE_TIMELOCK`, not the deployer, code that does not start with
///      `0xef0100`, `getThreshold() >= 2`, and `getOwners().length >= threshold`.
///      Agents do not pass `--broadcast`. Spencer broadcasts from his keystore.
contract DeployTimelock is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant ANVIL_CHAIN_ID = 31337;
    uint256 public constant BASE_MAINNET_CHAIN_ID = 8453;
    uint256 public constant ETH_MAINNET_CHAIN_ID = 1;
    uint256 public constant TESTNET_MIN_DELAY = 300;
    uint256 public constant MAINNET_MIN_DELAY = 48 hours;

    /// @dev Dry-run sender used by the escrow deploy script. Broadcast must not use it.
    address public constant SIMULATE_SENDER = 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001;

    /// @dev Foundry's sender when `--sender` / `--account` is omitted.
    address public constant FOUNDRY_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// @dev The EOA this controller replaces. It must not be the Safe and must not hold a timelock role.
    address public constant CORE_TIMELOCK = 0x10CC9474b45625ADfd05C209f2518023484878D9;

    /// @dev Set by tests so parallel `forge test` runs do not share `ALLOW_MAINNET`. Operators use the env var.
    bool public forceAllowMainnet;

    function broadcasting() public view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    function allowMainnet() public view returns (bool allowed) {
        if (forceAllowMainnet) return true;
        try vm.envUint("ALLOW_MAINNET") returns (uint256 flag) {
            allowed = flag == 1;
        } catch {
            allowed = false;
        }
    }

    /// @notice Test-only. Broadcast still requires `ALLOW_MAINNET=1`.
    function allowMainnetForTest() external {
        if (broadcasting()) revert("DeployTimelock: set ALLOW_MAINNET=1");
        forceAllowMainnet = true;
    }

    /// @notice 84532 and 31337 proceed. 8453 and 1 proceed only when `ALLOW_MAINNET=1`. Every other chain reverts.
    function requireAllowedChain() public view {
        uint256 id = block.chainid;
        if (id == BASE_SEPOLIA_CHAIN_ID || id == ANVIL_CHAIN_ID) return;
        if ((id == BASE_MAINNET_CHAIN_ID || id == ETH_MAINNET_CHAIN_ID) && allowMainnet()) {
            console.log("WARNING: mainnet is not in scope");
            return;
        }
        revert("DeployTimelock: chain refused");
    }

    /// @notice 300 seconds on 84532 and 31337. 48 hours on 8453 and 1. Every other chain reverts.
    function minDelayFloor() public view returns (uint256) {
        uint256 id = block.chainid;
        if (id == BASE_MAINNET_CHAIN_ID || id == ETH_MAINNET_CHAIN_ID) return MAINNET_MIN_DELAY;
        if (id == BASE_SEPOLIA_CHAIN_ID || id == ANVIL_CHAIN_ID) return TESTNET_MIN_DELAY;
        revert("DeployTimelock: chain refused");
    }

    /// @notice Broadcast must name a keystore account. The default Foundry sender and the dry-run burn address are
    /// refused.
    function requireBroadcastSender(
        address sender
    ) public pure {
        if (sender == FOUNDRY_DEFAULT_SENDER || sender == SIMULATE_SENDER) {
            revert("DeployTimelock: pass --account and --sender");
        }
    }

    function readAddress(
        string memory key,
        string memory unsetErr
    ) public view returns (address a) {
        try vm.envAddress(key) returns (address set) {
            a = set;
        } catch {
            revert(unsetErr);
        }
        if (a == address(0)) revert(unsetErr);
    }

    function readMinDelay() public view returns (uint256 delay) {
        try vm.envUint("TIMELOCK_MIN_DELAY") returns (uint256 set) {
            delay = set;
        } catch {
            revert("DeployTimelock: TIMELOCK_MIN_DELAY unset");
        }
    }

    /// @dev Unset means open execution (`address(0)` holds `EXECUTOR_ROLE`). A non-zero value is that executor (the
    /// Safe).
    function readExecutor() public view returns (address executor) {
        try vm.envAddress("TIMELOCK_EXECUTOR") returns (address set) {
            executor = set;
        } catch {
            executor = address(0);
        }
    }

    /// @notice Deploy the controller and assert no EOA holds `DEFAULT_ADMIN_ROLE`.
    /// @dev Reverts unless the Safe check and the delay floor both pass. This function does not create a Safe.
    function deployTimelock(
        address safe,
        uint256 minDelay,
        address executor
    ) public returns (TimelockController timelock) {
        requireAllowedChain();
        _requireSafe(safe);
        if (minDelay < minDelayFloor()) revert("DeployTimelock: minDelay below floor");

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = executor;

        // admin = address(0): self-administered. OZ v5 also grants CANCELLER_ROLE to each proposer.
        timelock = new TimelockController(minDelay, proposers, executors, address(0));

        bytes32 adminRole = timelock.DEFAULT_ADMIN_ROLE();
        if (!timelock.hasRole(adminRole, address(timelock))) {
            revert("DeployTimelock: timelock missing DEFAULT_ADMIN_ROLE");
        }
        if (timelock.hasRole(adminRole, msg.sender)) revert("DeployTimelock: deployer holds DEFAULT_ADMIN_ROLE");
        if (timelock.hasRole(adminRole, tx.origin)) revert("DeployTimelock: tx.origin holds DEFAULT_ADMIN_ROLE");
        if (timelock.hasRole(adminRole, safe)) revert("DeployTimelock: SAFE holds DEFAULT_ADMIN_ROLE");
        if (timelock.hasRole(adminRole, address(0))) revert("DeployTimelock: address(0) holds DEFAULT_ADMIN_ROLE");
        if (!timelock.hasRole(timelock.PROPOSER_ROLE(), safe)) revert("DeployTimelock: SAFE missing PROPOSER_ROLE");
        if (!timelock.hasRole(timelock.CANCELLER_ROLE(), safe)) revert("DeployTimelock: SAFE missing CANCELLER_ROLE");
        if (!timelock.hasRole(timelock.EXECUTOR_ROLE(), executor)) {
            revert("DeployTimelock: executor missing EXECUTOR_ROLE");
        }
        if (timelock.getMinDelay() != minDelay) revert("DeployTimelock: minDelay mismatch");
        if (timelock.hasRole(timelock.PROPOSER_ROLE(), CORE_TIMELOCK)) {
            revert("DeployTimelock: CORE_TIMELOCK holds PROPOSER_ROLE");
        }
        if (timelock.hasRole(timelock.EXECUTOR_ROLE(), CORE_TIMELOCK)) {
            revert("DeployTimelock: CORE_TIMELOCK holds EXECUTOR_ROLE");
        }
        if (timelock.hasRole(timelock.CANCELLER_ROLE(), CORE_TIMELOCK)) {
            revert("DeployTimelock: CORE_TIMELOCK holds CANCELLER_ROLE");
        }
        if (timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), CORE_TIMELOCK)) {
            revert("DeployTimelock: CORE_TIMELOCK holds DEFAULT_ADMIN_ROLE");
        }
    }

    function run() external {
        requireAllowedChain();
        address safe = readAddress("SAFE_ADDRESS", "DeployTimelock: SAFE_ADDRESS unset");
        uint256 minDelay = readMinDelay();
        address executor = readExecutor();

        address deployer = msg.sender;
        if (broadcasting()) {
            requireBroadcastSender(deployer);
            console.log("BROADCAST Spencer-only");
        } else {
            console.log("SIMULATE; no transaction will be sent");
        }

        console.log("chainid", block.chainid);
        console.log("SAFE_ADDRESS", safe);
        console.log("TIMELOCK_MIN_DELAY", minDelay);
        console.log("TIMELOCK_EXECUTOR", executor);
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) {
            console.log("deploy target is Base Sepolia (84532); this chain is not that target");
        }

        vm.startBroadcast();
        TimelockController timelock = deployTimelock(safe, minDelay, executor);
        vm.stopBroadcast();

        console.log("TimelockController", address(timelock));
        console.log("DEFAULT_ADMIN_ROLE holder", address(timelock));
        console.log("Mainnet is not in scope. Do not set ALLOW_MAINNET.");
        console.log("Agents must not --broadcast.");
    }

    /// @dev Code length is not enough: an EIP-7702 designator (`0xef0100` plus an address) has code.
    function _requireSafe(
        address safe
    ) internal view {
        if (safe == address(0)) revert("DeployTimelock: SAFE_ADDRESS unset");
        if (safe == CORE_TIMELOCK) revert("DeployTimelock: SAFE_ADDRESS is CORE_TIMELOCK");
        if (safe == msg.sender) revert("DeployTimelock: SAFE_ADDRESS is the deployer");
        if (safe.code.length == 0) revert("DeployTimelock: SAFE_ADDRESS has no code");
        if (_isDelegation(safe)) revert("DeployTimelock: SAFE_ADDRESS is an EIP-7702 delegation");
        uint256 threshold = ISafe(safe).getThreshold();
        if (threshold < 2) revert("DeployTimelock: SAFE threshold is below 2");
        if (ISafe(safe).getOwners().length < threshold) {
            revert("DeployTimelock: SAFE owners are below the threshold");
        }
    }

    function _isDelegation(
        address account
    ) internal view returns (bool) {
        bytes memory code = account.code;
        return code.length >= 3 && code[0] == bytes1(0xef) && code[1] == bytes1(0x01) && code[2] == bytes1(0x00);
    }
}
