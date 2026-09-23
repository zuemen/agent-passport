# @agent-passport/verifier

Off-chain vLEI owner verification. A role holder of a legal entity (GLEIF vLEI OOR credential) binds an
Agent Passport credential with a KERI signature; this service checks the credential chain to the trusted
root and the signature, then records `VLEI_VERIFIED` + `keccak256(OOR SAID)` on Monad.

```bash
npm run chain -w verifier    # build the TEST chain on a local KERIA stack (see ../docs/VLEI_SETUP.md)
npm run verify -w verifier   # bind + present + verify + record on Monad testnet
npm test -w verifier         # unit tests (no KERIA needed)
```

| File | |
|---|---|
| `src/keri.ts` | signify-ts helpers: clients, AIDs, registries, issue, IPEX grant/admit |
| `src/setupChain.ts` | test chain: GLEIF root → QVI → Example Treasury Ltd → OOR AUTH → OOR |
| `src/verifyOwner.ts` | chain + signature checks |
| `src/run.ts` | end to end, with two negative controls, writes `demo/public/runs/vlei-latest.json` |

Test data only — fictional entity, `APTEST…` LEIs, no real person.
