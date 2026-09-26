import balanceFile from "../../fixtures/reputation/EXAMPLE-DATA.balance.example.json"
import configFile from "../../fixtures/reputation/EXAMPLE-DATA.config.example.json"
import historyFile from "../../fixtures/reputation/EXAMPLE-DATA.history.example.json"
import { parseBalance, parseConfig, parseHistory } from "./api"
import type { ReputationHistory, ReputationSnapshot } from "./types"

export const EXAMPLE_DATA_LABEL = balanceFile.label

const balance = parseBalance(balanceFile.response)
const config = parseConfig(configFile.response)
const usageHistory = parseHistory(historyFile.response)

/** The copied history fixture is the usage ledger only. Arbitrator history is an empty page. */
const arbitratorHistory: ReputationHistory = {
  address: balance.address,
  chainId: balance.chainId,
  ledger: "arbitrator",
  items: [],
  next_cursor: null,
}

export const exampleSnapshot: ReputationSnapshot = {
  balance,
  config,
  history: {
    usage: usageHistory,
    arbitrator: arbitratorHistory,
  },
}

export const exampleFiles = {
  balance: balanceFile,
  config: configFile,
  history: historyFile,
}
