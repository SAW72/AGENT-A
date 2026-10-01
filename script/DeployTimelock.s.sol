// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Deploy an OpenZeppelin `TimelockController` (v5.7.0, the version pinned in `foundry.lock`).
/// @dev Proposer is `SAFE_ADDRESS` only. OZ v5 grants that proposer `CANCELLER_ROLE` in the constructor.
///      `admin` is `address(0)`, so `DEFAULT_ADMIN_ROLE` stays on the timelock itself. No EOA is admin.
///      Broadcast is `vm.startBroadcast()` with no key. Foundry signs from `--account` / `--sender`.
///      This script never reads `PRIVATE_KEY`.
///      Runs only on chainid 84532 (Base Sepolia) or 31337 (Anvil). Every other chain reverts unless
///      `ALLOW_MAINNET=1`. Mainnet is not in scope.
///      Testnet `TIMELOCK_MIN_DELAY` may be short (for example 300).
///      A delay under 48 hours on chainid 8453 logs a warning and does not revert.
///      Agents do not pass `--broadcast`. Spencer broadcasts from his keystore.
contract DeployTimelock is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant ANVIL_CHAIN_ID = 31337;
    uint256 public constant BASE_MAINNET_CHAIN_ID = 8453;
    uint256 public constant ETH_MAINNET_CHAIN_ID = 1;
    uint256 public constant MIN_MAINNET_DELAY = 48 hours;

    /// @dev Dry-run sender used by the escrow deploy script. Broadcast must not use it.
    address public constant SIMULATE_SENDER = 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001;

    /// @dev Foundry's sender when `--sender` / `--account` is omitted.
    address public constant FOUNDRY_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// @dev Set when `noteShortDelay` sees chainid 8453 and a delay under 48 hours.
    bool public shortDelayWarned;

    function broadcasting() public view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    function allowMainnet() public view returns (bool allowed) {
        try vm.envUint("ALLOW_MAINNET") returns (uint256 flag) {
            allowed = flag == 1;
        } catch {
            allowed = false;
        }
    }

    /// @notice Base Sepolia (84532) and Anvil (31337) proceed. Every other chain reverts unless `ALLOW_MAINNET=1`.
    ///         Mainnet is not an intended target.
    function requireAllowedChain() public view {
        if (block.chainid == BASE_SEPOLIA_CHAIN_ID || block.chainid == ANVIL_CHAIN_ID) return;
        if (!allowMainnet()) revert("DeployTimelock: chain refused; only 84532 or 31337 unless ALLOW_MAINNET=1");
        console.log("WARNING: mainnet is not in scope");
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

    /// @notice Log when chainid is 8453 and the delay is under 48 hours. Does not revert. Testnet delays may be short.
    function noteShortDelay(
        uint256 minDelay
    ) public {
        shortDelayWarned = false;
        if (block.chainid == BASE_MAINNET_CHAIN_ID && minDelay < MIN_MAINNET_DELAY) {
            shortDelayWarned = true;
            console.log("WARNING: TIMELOCK_MIN_DELAY is under 48 hours on chainid 8453");
        }
    }

    /// @notice Deploy the controller and assert no EOA holds `DEFAULT_ADMIN_ROLE`.
    /// @dev `SAFE_ADDRESS` must already have code. This function does not create a Safe.
    function deployTimelock(
        address safe,
        uint256 minDelay,
        address executor
    ) public returns (TimelockController timelock) {
        if (safe == address(0)) revert("DeployTimelock: SAFE_ADDRESS unset");
        if (safe.code.length == 0) revert("DeployTimelock: SAFE_ADDRESS has no code");

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
    }

    function run() external {
        requireAllowedChain();
        address safe = readAddress("SAFE_ADDRESS", "DeployTimelock: SAFE_ADDRESS unset");
        uint256 minDelay = readMinDelay();
        address executor = readExecutor();
        noteShortDelay(minDelay);

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
}
