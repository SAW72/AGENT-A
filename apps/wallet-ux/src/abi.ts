import type { Abi } from "viem"
import escrowAbiJson from "./abi/BotAttestationEscrow.json"
import denylistAbiJson from "./abi/Denylist.json"
import disputePanelAbiJson from "./abi/DisputePanel.json"
import insuranceFundAbiJson from "./abi/InsuranceFund.json"
import vaultHookAbiJson from "./abi/IVault.json"
import liabilityAbiJson from "./abi/Liability.json"

export const escrowAbi = escrowAbiJson as Abi
export const denylistAbi = denylistAbiJson as Abi
/** Wallet ABI hook (`contracts/interfaces/IVault.sol`). Reads only. */
export const vaultAbi = vaultHookAbiJson as Abi
export const disputePanelAbi = disputePanelAbiJson as Abi
export const liabilityAbi = liabilityAbiJson as Abi
export const insuranceFundAbi = insuranceFundAbiJson as Abi
