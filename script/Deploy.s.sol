// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { Vault } from "../contracts/Vault.sol";
import { InsuranceFund } from "../contracts/InsuranceFund.sol";
import { Liability } from "../contracts/Liability.sol";
import { DisputePanel } from "../contracts/DisputePanel.sol";

/// @notice Deploy Denylist → Vault → Liability → InsuranceFund → DisputePanel.
/// InsuranceFund takes an immutable Liability; Liability then bindInsurance.
/// After deploy: Denylist/Vault `transferOwnership(CORE_TIMELOCK)` (Ownable2Step;
/// CORE_TIMELOCK must `acceptOwnership`). CORE_TIMELOCK is an EOA (with EIP-7702 delegation), not a timelock; to be
/// replaced by TimelockController (docs/runbooks/CORE_TIMELOCK_MIGRATION.md). InsuranceFund/Liability/DisputePanel
/// `setOwner(CORE_TIMELOCK)`. InsuranceFund.payout stays onlyLiability.
/// Chainid guard: Base Sepolia (84532) only. Mainnet is always refused.
/// ETH Sepolia (11155111) is documented as a one-line switch — do not enable it
/// here unless you intentionally change ALLOWED_CHAIN_ID.
contract Deploy is Script {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant ETH_SEPOLIA_CHAIN_ID = 11155111;
    uint256 public constant ETH_MAINNET_CHAIN_ID = 1;
    uint256 public constant ALLOWED_CHAIN_ID = BASE_SEPOLIA_CHAIN_ID;

    function requireAllowedChain() public view {
        if (block.chainid == ETH_MAINNET_CHAIN_ID) {
            revert("Deploy: mainnet forbidden");
        }
        if (block.chainid != ALLOWED_CHAIN_ID) {
            revert("Deploy: Base Sepolia (84532) only; see README to switch to ETH Sepolia (11155111)");
        }
    }

    function requireTimelock(address deployer, address timelock) public pure {
        if (timelock == address(0)) revert("Deploy: CORE_TIMELOCK unset");
        if (timelock == deployer) revert("Deploy: CORE_TIMELOCK must not be deployer");
    }

    function run() external {
        requireAllowedChain();

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address timelock = vm.envAddress("CORE_TIMELOCK");
        requireTimelock(deployer, timelock);

        vm.startBroadcast(deployerKey);

        Denylist denylist = new Denylist();
        Vault vault = new Vault(address(denylist));
        // Liability first so InsuranceFund can freeze it as immutable onlyLiability.
        Liability liability = new Liability(address(0));
        InsuranceFund insurance = new InsuranceFund(address(liability));
        liability.bindInsurance(address(insurance));
        DisputePanel panel = new DisputePanel();

        denylist.transferOwnership(timelock);
        vault.transferOwnership(timelock);
        insurance.setOwner(timelock);
        liability.setOwner(timelock);
        panel.setOwner(timelock);

        vm.stopBroadcast();

        console.log("chainid", block.chainid);
        console.log("Denylist", address(denylist));
        console.log("Vault", address(vault));
        console.log("InsuranceFund", address(insurance));
        console.log("Liability", address(liability));
        console.log("DisputePanel", address(panel));
        console.log("CORE_TIMELOCK", timelock);
        console.log("Post these addresses in contracts/README.md and deployments/base-sepolia.json. Never commit PRIVATE_KEY.");
        console.log("Post-step: CORE_TIMELOCK must setArbitrator three times before openDispute (reverts until arbitratorCount >= 3).");
    }
}
