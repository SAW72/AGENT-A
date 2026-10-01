import { createPublicClient, getAddress, http, isAddress, type Address } from "viem"
import { baseSepolia } from "viem/chains"
import { denylistAbi, disputePanelAbi, escrowAbi, insuranceFundAbi, liabilityAbi, vaultAbi } from "./abi"
import { ADDRESSES, BASE_SEPOLIA_CHAIN_ID } from "./addresses"

export const DEFAULT_RPC_URL = "https://sepolia.base.org"

export function rpcUrlFromEnv(value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : DEFAULT_RPC_URL
}

export function rpcHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return "unparsed RPC URL"
  }
}

export function createSepoliaClient(url: string) {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(url, { timeout: 20_000 }),
  })
}

export type SepoliaClient = ReturnType<typeof createSepoliaClient>

export type GateStatus = {
  chainId: number
  denylist: { owner: Address; pendingOwner: Address }
  vault: { owner: Address; pendingOwner: Address; denylist: Address }
  disputePanel: { owner: Address; arbitratorCount: bigint; panelSize: bigint }
  liability: { owner: Address; insurance: Address; nativeBalanceWei: bigint }
  insuranceFund: {
    owner: Address
    liability: Address
    recordedBalanceWei: bigint
    nativeBalanceWei: bigint
  }
  escrow: EscrowStatus | null
}

export type EscrowStatus = {
  owner: Address
  pendingOwner: Address
  governance: Address
  disputePanel: Address
  denylist: Address
  vault: Address
  lockedValueWei: bigint
  nativeBalanceWei: bigint
  fundingOpen: boolean
}

export type EscrowRecord = {
  used: boolean
  payer: Address
  payee: Address
  payerBotId: `0x${string}`
  payeeBotId: `0x${string}`
  amountWei: bigint
  createdAt: bigint
  expiresAt: bigint
  state: number
  disputeId: `0x${string}`
}

export type Membership = {
  exact: boolean
  signature: boolean
  prompt: boolean
}

export function panelNotSeated(arbitratorCount: bigint, panelSize: bigint): boolean {
  return arbitratorCount < panelSize
}

function asAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error(`Expected an address from ${label}.`)
  }
  return getAddress(value)
}

function asBigint(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value
  throw new Error(`Expected a uint from ${label}.`)
}

function asBool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Expected a bool from ${label}.`)
  return value
}

function asLevel(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value === "bigint") return Number(value)
  throw new Error("Expected a match level from check().")
}

async function assertSepoliaRpc(client: SepoliaClient): Promise<number> {
  const chainId = await client.getChainId()
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Refusing reads on chain id ${chainId}. This client only talks to Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}).`,
    )
  }
  return chainId
}

const PINNED_CODE = [
  ["Denylist", ADDRESSES.denylist],
  ["Vault", ADDRESSES.vault],
  ["DisputePanel", ADDRESSES.disputePanel],
  ["Liability", ADDRESSES.liability],
  ["InsuranceFund", ADDRESSES.insuranceFund],
] as const

export async function readGateStatus(client: SepoliaClient): Promise<GateStatus> {
  const chainId = await assertSepoliaRpc(client)

  const code = await Promise.all(
    PINNED_CODE.map(async ([label, address]) => {
      const bytecode = await client.getBytecode({ address })
      return { label, address, empty: bytecode == null || bytecode === "0x" }
    }),
  )
  const missing = code.filter((row) => row.empty)
  if (missing.length > 0) {
    const listed = missing.map((row) => `${row.label} ${row.address}`).join(", ")
    throw new Error(`No contract code at ${listed}.`)
  }

  const [packed, liabilityNative, insuranceNative] = await Promise.all([
    client.multicall({
      allowFailure: false,
      contracts: [
        { address: ADDRESSES.denylist, abi: denylistAbi, functionName: "owner" },
        { address: ADDRESSES.denylist, abi: denylistAbi, functionName: "pendingOwner" },
        { address: ADDRESSES.vault, abi: vaultAbi, functionName: "owner" },
        { address: ADDRESSES.vault, abi: vaultAbi, functionName: "pendingOwner" },
        { address: ADDRESSES.vault, abi: vaultAbi, functionName: "denylist" },
        { address: ADDRESSES.disputePanel, abi: disputePanelAbi, functionName: "owner" },
        { address: ADDRESSES.disputePanel, abi: disputePanelAbi, functionName: "arbitratorCount" },
        { address: ADDRESSES.disputePanel, abi: disputePanelAbi, functionName: "PANEL_SIZE" },
        { address: ADDRESSES.liability, abi: liabilityAbi, functionName: "owner" },
        { address: ADDRESSES.liability, abi: liabilityAbi, functionName: "insurance" },
        { address: ADDRESSES.insuranceFund, abi: insuranceFundAbi, functionName: "owner" },
        { address: ADDRESSES.insuranceFund, abi: insuranceFundAbi, functionName: "liability" },
        { address: ADDRESSES.insuranceFund, abi: insuranceFundAbi, functionName: "balance" },
      ],
    }),
    client.getBalance({ address: ADDRESSES.liability }),
    client.getBalance({ address: ADDRESSES.insuranceFund }),
  ])

  const [
    denylistOwner,
    denylistPending,
    vaultOwner,
    vaultPending,
    vaultDenylist,
    panelOwner,
    arbitratorCount,
    panelSize,
    liabilityOwner,
    liabilityInsurance,
    insuranceOwner,
    insuranceLiability,
    insuranceBalance,
  ] = packed

  return {
    chainId,
    denylist: {
      owner: asAddress(denylistOwner, "Denylist.owner"),
      pendingOwner: asAddress(denylistPending, "Denylist.pendingOwner"),
    },
    vault: {
      owner: asAddress(vaultOwner, "Vault.owner"),
      pendingOwner: asAddress(vaultPending, "Vault.pendingOwner"),
      denylist: asAddress(vaultDenylist, "Vault.denylist"),
    },
    disputePanel: {
      owner: asAddress(panelOwner, "DisputePanel.owner"),
      arbitratorCount: asBigint(arbitratorCount, "DisputePanel.arbitratorCount"),
      panelSize: asBigint(panelSize, "DisputePanel.PANEL_SIZE"),
    },
    liability: {
      owner: asAddress(liabilityOwner, "Liability.owner"),
      insurance: asAddress(liabilityInsurance, "Liability.insurance"),
      nativeBalanceWei: liabilityNative,
    },
    insuranceFund: {
      owner: asAddress(insuranceOwner, "InsuranceFund.owner"),
      liability: asAddress(insuranceLiability, "InsuranceFund.liability"),
      recordedBalanceWei: asBigint(insuranceBalance, "InsuranceFund.balance"),
      nativeBalanceWei: insuranceNative,
    },
    escrow: ADDRESSES.botAttestationEscrow
      ? await readEscrowStatus(client, ADDRESSES.botAttestationEscrow)
      : null,
  }
}

const ESCROW_STATES = ["Open", "Released", "Refunded", "Disputed"] as const

export function escrowStateLabel(state: number): string {
  return ESCROW_STATES[state] ?? `Unknown(${state})`
}

export async function readEscrowStatus(client: SepoliaClient, address: Address): Promise<EscrowStatus> {
  await assertSepoliaRpc(client)
  const bytecode = await client.getBytecode({ address })
  if (bytecode == null || bytecode === "0x") throw new Error(`No contract code at BotAttestationEscrow ${address}.`)

  const [packed, nativeBalanceWei] = await Promise.all([
    client.multicall({
      allowFailure: false,
      contracts: [
        { address, abi: escrowAbi, functionName: "owner" },
        { address, abi: escrowAbi, functionName: "pendingOwner" },
        { address, abi: escrowAbi, functionName: "governance" },
        { address, abi: escrowAbi, functionName: "disputePanel" },
        { address, abi: escrowAbi, functionName: "denylist" },
        { address, abi: escrowAbi, functionName: "vault" },
        { address, abi: escrowAbi, functionName: "lockedValue" },
      ],
    }),
    client.getBalance({ address }),
  ])
  const [owner, pendingOwner, governance, disputePanel, denylist, vault, lockedValue] = packed
  const ownerAddress = asAddress(owner, "Escrow.owner")
  const governanceAddress = asAddress(governance, "Escrow.governance")
  return {
    owner: ownerAddress,
    pendingOwner: asAddress(pendingOwner, "Escrow.pendingOwner"),
    governance: governanceAddress,
    disputePanel: asAddress(disputePanel, "Escrow.disputePanel"),
    denylist: asAddress(denylist, "Escrow.denylist"),
    vault: asAddress(vault, "Escrow.vault"),
    lockedValueWei: asBigint(lockedValue, "Escrow.lockedValue"),
    nativeBalanceWei,
    fundingOpen: ownerAddress.toLowerCase() === governanceAddress.toLowerCase(),
  }
}

function tupleField(value: unknown, index: number, name: string): unknown {
  if (Array.isArray(value)) return value[index]
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    if (name in record) return record[name]
    if (String(index) in record) return record[String(index)]
  }
  throw new Error(`Expected escrow field ${name}.`)
}

function asBytes32(value: unknown, label: string): `0x${string}` {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Expected bytes32 from ${label}.`)
  }
  return value.toLowerCase() as `0x${string}`
}

export async function readEscrowById(
  client: SepoliaClient,
  address: Address,
  escrowId: `0x${string}`,
): Promise<EscrowRecord> {
  await assertSepoliaRpc(client)
  const [row, used] = await Promise.all([
    client.readContract({ address, abi: escrowAbi, functionName: "escrows", args: [escrowId] }),
    client.readContract({ address, abi: escrowAbi, functionName: "usedEscrowIds", args: [escrowId] }),
  ])
  return {
    used: asBool(used, "usedEscrowIds"),
    payer: asAddress(tupleField(row, 0, "payer"), "escrows.payer"),
    payee: asAddress(tupleField(row, 1, "payee"), "escrows.payee"),
    payerBotId: asBytes32(tupleField(row, 2, "payerBotId"), "escrows.payerBotId"),
    payeeBotId: asBytes32(tupleField(row, 3, "payeeBotId"), "escrows.payeeBotId"),
    amountWei: asBigint(tupleField(row, 4, "amount"), "escrows.amount"),
    createdAt: asBigint(tupleField(row, 5, "createdAt"), "escrows.createdAt"),
    expiresAt: asBigint(tupleField(row, 6, "expiresAt"), "escrows.expiresAt"),
    state: asLevel(tupleField(row, 7, "state")),
    disputeId: asBytes32(tupleField(row, 8, "disputeId"), "escrows.disputeId"),
  }
}

export async function readMembership(client: SepoliaClient, id: `0x${string}`): Promise<Membership> {
  await assertSepoliaRpc(client)
  const [exact, signature, prompt] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: ADDRESSES.denylist, abi: denylistAbi, functionName: "denylistedHashes", args: [id] },
      { address: ADDRESSES.denylist, abi: denylistAbi, functionName: "denylistedSignatures", args: [id] },
      { address: ADDRESSES.denylist, abi: denylistAbi, functionName: "denylistedPrompts", args: [id] },
    ],
  })
  return {
    exact: asBool(exact, "denylistedHashes"),
    signature: asBool(signature, "denylistedSignatures"),
    prompt: asBool(prompt, "denylistedPrompts"),
  }
}

export async function readCheck(
  client: SepoliaClient,
  weightHash: `0x${string}`,
  behaviorSig: `0x${string}`,
  promptHash: `0x${string}`,
): Promise<number> {
  await assertSepoliaRpc(client)
  const level = await client.readContract({
    address: ADDRESSES.denylist,
    abi: denylistAbi,
    functionName: "check",
    args: [weightHash, behaviorSig, promptHash],
  })
  return asLevel(level)
}
