// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { console } from "forge-std/Script.sol";
import { DisputePanel } from "../contracts/DisputePanel.sol";
import { OpsLive } from "./OpsLive.sol";

/// @notice Shared Gate B helpers for the live Base Sepolia DisputePanel.
/// @dev Does not deploy the panel and does not redeploy Denylist or Vault.
///      Dry-run impersonates `CORE_TIMELOCK` via `OpsLive.asOwner` and sends nothing.
///      `--broadcast` / `--resume` revert unless `PRIVATE_KEY` is that owner.
///      `openDispute` reverts `panel not seated` until `arbitratorCount >= 3`.
///      Prefer `OpsDisputePanelSeat` before `DeployBotAttestationEscrow` broadcast.
abstract contract OpsDisputePanel is OpsLive {
    address public constant LIVE_DISPUTE_PANEL = 0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb;

    function assertCanonicalPanel(
        address panel,
        address timelock
    ) public pure {
        if (panel != LIVE_DISPUTE_PANEL) {
            revert("OpsPanel: DISPUTE_PANEL is not the live Base Sepolia DisputePanel");
        }
        if (timelock != LIVE_TIMELOCK) revert("OpsLive: CORE_TIMELOCK is not the live owner");
    }

    function assertPanelOwner(
        address owner,
        address timelock
    ) public pure {
        if (owner != timelock) revert("OpsPanel: DisputePanel.owner is not CORE_TIMELOCK");
    }

    /// @notice Three seats must be distinct and non-zero. `openDispute` needs all three.
    function requireDistinct(
        address a,
        address b,
        address c
    ) public pure {
        if (a == address(0) || b == address(0) || c == address(0)) revert("OpsPanel: zero arbitrator");
        if (a == b || a == c || b == c) revert("OpsPanel: duplicate arbitrator");
    }

    /// @dev Same rule as `OpsLive.asOwner`: a broadcast whose signer is not the live owner reverts.
    ///      Dry-run (`doBroadcast == false`) does not check the key.
    function requireBroadcastSigner(
        address signer,
        address timelock,
        bool doBroadcast
    ) public pure {
        if (!doBroadcast) return;
        if (signer != timelock) revert("OpsLive: PRIVATE_KEY is not the live owner; Spencer only");
    }

    /// @notice Load the live panel after env addresses match the book and `owner()` matches.
    function loadPanel() public view returns (DisputePanel panel, address timelock) {
        address panelAddr = readAddress("DISPUTE_PANEL", "OpsPanel: DISPUTE_PANEL unset");
        timelock = readAddress("CORE_TIMELOCK", "OpsLive: CORE_TIMELOCK unset");
        assertCanonicalPanel(panelAddr, timelock);
        panel = DisputePanel(panelAddr);
        assertPanelOwner(panel.owner(), timelock);
    }

    /// @notice One `setArbitrator`. No-ops when the allowlist bit is already `allowed`.
    function applyOne(
        DisputePanel panel,
        address timelock,
        address account,
        bool allowed
    ) public {
        if (account == address(0)) revert("OpsPanel: zero arbitrator");
        if (timelock == address(0)) revert("OpsLive: owner unset");
        if (panel.isArbitrator(account) == allowed) {
            console.log("unchanged");
            console.log(account);
            return;
        }
        if (broadcasting()) {
            requireBroadcastSigner(vm.addr(vm.envUint("PRIVATE_KEY")), timelock, true);
        }
        console.log("setArbitrator");
        console.log(account);
        console.log("allowed", allowed);
        bool send = asOwner(timelock);
        panel.setArbitrator(account, allowed);
        finishOwner(send);
    }

    /// @notice Seat three distinct arbitrators. Does not remove anyone.
    function seat(
        DisputePanel panel,
        address timelock,
        address a,
        address b,
        address c
    ) public {
        requireDistinct(a, b, c);
        applyOne(panel, timelock, a, true);
        applyOne(panel, timelock, b, true);
        applyOne(panel, timelock, c, true);
    }

    function logSeat(
        DisputePanel panel
    ) public view {
        uint256 count = panel.arbitratorCount();
        console.log("arbitratorCount", count);
        console.log("panel size", panel.PANEL_SIZE());
        if (count >= panel.PANEL_SIZE()) {
            console.log("Gate B seated. openDispute can succeed.");
        } else {
            console.log("Gate B not seated. openDispute reverts until arbitratorCount >= 3.");
        }
    }
}

/// @notice `DisputePanel.setArbitrator(account, true)` on the live Base Sepolia panel.
/// @dev Simulate: `forge script script/OpsDisputePanel.s.sol:OpsDisputePanelAdd --rpc-url $BASE_SEPOLIA_RPC_URL`
///      Agents must not pass `--broadcast`. See script/DEPLOY_ESCROW_BASE_SEPOLIA.md.
contract OpsDisputePanelAdd is OpsDisputePanel {
    function run() external {
        requireAllowedChain();
        (DisputePanel panel, address timelock) = loadPanel();
        address account = readAddress("ARBITRATOR", "OpsPanel: ARBITRATOR unset");
        console.log("op add");
        console.log("chainid", block.chainid);
        console.log("DisputePanel", address(panel));
        console.log("CORE_TIMELOCK", timelock);
        applyOne(panel, timelock, account, true);
        logSeat(panel);
    }
}

/// @notice `DisputePanel.setArbitrator(account, false)` on the live Base Sepolia panel.
contract OpsDisputePanelRemove is OpsDisputePanel {
    function run() external {
        requireAllowedChain();
        (DisputePanel panel, address timelock) = loadPanel();
        address account = readAddress("ARBITRATOR", "OpsPanel: ARBITRATOR unset");
        console.log("op remove");
        console.log("chainid", block.chainid);
        console.log("DisputePanel", address(panel));
        console.log("CORE_TIMELOCK", timelock);
        applyOne(panel, timelock, account, false);
        logSeat(panel);
    }
}

/// @notice Seat Gate B: three `setArbitrator(..., true)` calls.
/// @dev Env `ARBITRATOR_1`, `ARBITRATOR_2`, `ARBITRATOR_3` must be distinct and non-zero.
///      Prefer this before broadcasting `DeployBotAttestationEscrow`.
///      `openDispute` keeps reverting until `arbitratorCount >= 3`.
contract OpsDisputePanelSeat is OpsDisputePanel {
    function run() external {
        requireAllowedChain();
        (DisputePanel panel, address timelock) = loadPanel();
        address a = readAddress("ARBITRATOR_1", "OpsPanel: ARBITRATOR_1 unset");
        address b = readAddress("ARBITRATOR_2", "OpsPanel: ARBITRATOR_2 unset");
        address c = readAddress("ARBITRATOR_3", "OpsPanel: ARBITRATOR_3 unset");
        console.log("op seat");
        console.log("chainid", block.chainid);
        console.log("DisputePanel", address(panel));
        console.log("CORE_TIMELOCK", timelock);
        console.log("arbitratorCount before", panel.arbitratorCount());
        console.log("openDispute needs arbitratorCount >= 3. Prefer seating before Escrow broadcast.");
        seat(panel, timelock, a, b, c);
        logSeat(panel);
    }
}
