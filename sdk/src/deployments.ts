import { monadTestnet } from "viem/chains";
import type { Address } from "viem";

export { monadTestnet };

/** Agent Passport on Monad testnet (chain id 10143). Source: contracts/deployments/10143.json. */
export const MONAD_TESTNET = {
  identityRegistry: "0x5Df260dec1Ba15368f7fBe338D01a4C764CEAA51",
  reputationRegistry: "0x726A215f33bE1Ca996Cf745D4ceee96b2d8f1EE7",
  validationRegistry: "0x35ab0e062A5BBfB64210Feb08FaE81969669dF76",
  credentialStatusRegistry: "0xD1bC9758F76b6Ea18fbEE824a8Fe8A99c5fcC451",
  passportGate: "0xb93Ddb5E34a2d8a16ebe3DA88851d4a805fFD109",
  groundedFeedback: "0x39Bacd864318b7a6ea647A5fcE695523d823633f",
  passkeyAccountFactory: "0x99B4CECeC7ce4efF9F2686dab74a2dCeb07766D4",
  passportDex: "0xEaa7574EBFaa724e0935476b4d4041B5Cf186DaC",
  passportMerchant: "0xB66472725612bc98b0fa8262ec15eb2a5184Df10",
  demoUsd: "0x3d3da601b45596FfC7aeB1B9346646e18DB151A8",
  demoWmon: "0x7A8D21f393B73D0371B0273FdFab7fde1A60245b",
  vleiVerifier: "0xb2B62161CdA11ae8a695ED571DC80ABCEAB18EF2",
} as const satisfies Record<string, Address>;

/** Official ERC-8004 reference deployment on Monad testnet (erc-8004/erc-8004-contracts). */
export const OFFICIAL_ERC8004_MONAD_TESTNET = {
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
} as const satisfies Record<string, Address>;
