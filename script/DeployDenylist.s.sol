// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { Vault } from "../contracts/Vault.sol";

/// @notice Redeploy tip-bytecode Denylist and a Vault bound to it.
/// Does not deploy Liability, InsuranceFund, DisputePanel, BotAttestationEscrow, or BVT.
/// Does not read or write any existing Denylist. The live pre-PR #10 deployment stays as it is.
/// After deploy: `transferOwnership(CORE_TIMELOCK)` on both (Ownable2Step). The deployer
/// stays owner until CORE_TIMELOCK calls `acceptOwnership` on each new contract.
/// Chainid guard: Base Sepolia (84532) only. Mainnet is always refused.
/// ETH Sepolia (11155111) is documented as a one-line switch — do not enable it
/// here unless you intentionally change ALLOWED_CHAIN_ID.
/// RPC is the forge CLI `--rpc-url` (`BASE_SEPOLIA_RPC_URL`). This script reads
/// `PRIVATE_KEY` and `CORE_TIMELOCK` and checks `block.chainid`.
/// Agents do not --broadcast. Spencer runs the broadcast command locally.
contract DeployDenylist is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant ETH_SEPOLIA_CHAIN_ID = 11155111;
    uint256 public constant ETH_MAINNET_CHAIN_ID = 1;
    uint256 public constant ALLOWED_CHAIN_ID = BASE_SEPOLIA_CHAIN_ID;

    function requireAllowedChain() public view {
        if (block.chainid == ETH_MAINNET_CHAIN_ID) {
            revert("DeployDenylist: mainnet forbidden");
        }
        if (block.chainid != ALLOWED_CHAIN_ID) {
            revert("DeployDenylist: Base Sepolia (84532) only; see README to switch to ETH Sepolia (11155111)");
        }
    }

    function requireTimelock(
        address deployer,
        address timelock
    ) public pure {
        if (timelock == address(0)) revert("DeployDenylist: CORE_TIMELOCK unset");
        if (timelock == deployer) revert("DeployDenylist: CORE_TIMELOCK must not be deployer");
    }

    /// @notice Deploy both contracts and start Ownable2Step handoff. No broadcast.
    function deploy(
        address deployer,
        address timelock
    ) public returns (Denylist denylist, Vault vault) {
        requireTimelock(deployer, timelock);
        denylist = new Denylist();
        vault = new Vault(address(denylist));
        denylist.transferOwnership(timelock);
        vault.transferOwnership(timelock);
    }

    function run() external {
        requireAllowedChain();

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address timelock = vm.envAddress("CORE_TIMELOCK");
        requireTimelock(deployer, timelock);

        vm.startBroadcast(deployerKey);
        (Denylist denylist, Vault vault) = deploy(deployer, timelock);
        vm.stopBroadcast();

        console.log("chainid", block.chainid);
        console.log("Denylist", address(denylist));
        console.log("Vault", address(vault));
        console.log("CORE_TIMELOCK", timelock);
        console.log("Agents must not --broadcast. Spencer runs forge script ... --broadcast.");
        console.log("Post-step: CORE_TIMELOCK acceptOwnership() on both new contracts. See script/DEPLOY_DENYLIST.md.");
        console.log("Spencer writes the real addresses into deployments/base-sepolia.json after broadcast.");
    }
}
