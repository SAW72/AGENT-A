import { ADDRESSES, CORE_TIMELOCK } from "./addresses"
import { isZeroAddress, sameAddress } from "./format"
import type { GateStatus } from "./read"

export function gateAOwnershipNotes(status: GateStatus): string[] {
  const notes: string[] = []
  if (!sameAddress(status.denylist.owner, CORE_TIMELOCK)) notes.push("Denylist owner is not CORE_TIMELOCK.")
  if (!isZeroAddress(status.denylist.pendingOwner)) notes.push("Denylist pendingOwner is set.")
  if (!sameAddress(status.vault.owner, CORE_TIMELOCK)) notes.push("Vault owner is not CORE_TIMELOCK.")
  if (!isZeroAddress(status.vault.pendingOwner)) notes.push("Vault pendingOwner is set.")
  if (!sameAddress(status.vault.denylist, ADDRESSES.denylist)) {
    notes.push("Vault.denylist() does not match the pinned Denylist.")
  }
  return notes
}

export function liabilityLinkNotes(status: GateStatus): string[] {
  const notes: string[] = []
  if (!sameAddress(status.liability.owner, CORE_TIMELOCK)) notes.push("Liability owner is not CORE_TIMELOCK.")
  if (!sameAddress(status.insuranceFund.owner, CORE_TIMELOCK)) {
    notes.push("InsuranceFund owner is not CORE_TIMELOCK.")
  }
  if (!sameAddress(status.liability.insurance, ADDRESSES.insuranceFund)) {
    notes.push("Liability.insurance() does not match the pinned InsuranceFund.")
  }
  if (!sameAddress(status.insuranceFund.liability, ADDRESSES.liability)) {
    notes.push("InsuranceFund.liability() does not match the pinned Liability.")
  }
  return notes
}
