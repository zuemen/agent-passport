# vLEI owner verification — setup and run

Status: **working** (2026-09-23). A test vLEI chain runs on a local KERIA stack; the verifier checks it
and records the result on Monad testnet.

## What is verified
```
test GLEIF root ─QVI▶ test QVI ─LE▶ Example Treasury Ltd ─OOR AUTH▶ QVI ─OOR▶ treasury officer (role AID)
                                                                                      │
             officer signs {"type":"AgentPassportOwnerBinding/v1", chainId, statusRegistry,
                            credentialId, issuer, lei}  ─────────────────────────────┘
```
The officer presents the OOR credential to the verifier over IPEX (KERIA validates signatures and anchors
on admit). `verifier/src/verifyOwner.ts` then checks: OOR schema and status; OOR AUTH names the same
person and LEI and authorised the issuing QVI; the Legal Entity vLEI has the same LEI and issued the
OOR AUTH; the QVI vLEI issued the LE credential and was issued by the **trusted root**; nothing revoked;
the binding signature verifies against the officer's current key state. Only then
`CredentialStatusRegistry.recordOwnerAssurance(credentialId, VLEI_VERIFIED, keccak256(OOR SAID))` is sent.

All identities are local test identities; the LEIs start with `APTEST` and the entity is fictional.

## Run
```bash
# KERIA + witnesses + vLEI schema server, from the signify-ts repository's docker-compose (0.4.0 images)
git clone https://github.com/WebOfTrust/signify-ts && cd signify-ts
# optional: don't publish witness / schema-server ports (lets it run beside other local KERI stacks)
printf 'services:\n  vlei-server:\n    ports: !reset []\n  witness-demo:\n    ports: !reset []\n' > docker-compose.override.yaml
docker compose -p agentpassport-vlei up -d --wait

cd <agent-passport>
npm run chain -w verifier      # build the test chain (idempotent; state in verifier/.state/, git-ignored)
npm run verify -w verifier     # officer binds the demo credential, presents OOR, verifier checks, records on Monad
npm test -w verifier           # chain-walking and signature checks against fixtures (no KERIA needed)
```
Only KERIA's ports (3901–3903) are used from the host; witnesses and the schema server are reached by
KERIA over the docker network (`http://witness-demo:5642`, `http://vlei-server:7723`).

Result of the run on 2026-09-23: verification passed; a statement for a different credential and a chain
from an untrusted root were both rejected; `VLEI_VERIFIED` recorded on Monad testnet — see
[`demo/public/runs/vlei-latest.json`](../demo/public/runs/vlei-latest.json).

## Schema SAIDs
| Credential | SAID |
|---|---|
| QVI | `EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao` |
| Legal Entity | `ENPXp1vQzRF6JwIuS-mp2U8Uf1MoADoP_GqQ62VsDZWY` |
| OOR Auth | `EKA57bKBKxr_kN7iN5i7lMUxpMG-s19dRcmov1iDxz-E` |
| OOR | `EBNaNu-M9P5cgrnfl2Fvymy4E_jvxxyjb70PRtiANlJy` |

## Notes and limits
- KERIA notifies a sender of its own IPEX grant; the helpers match grants by SAID and mark the sender's
  own notification, otherwise an issuer that is also a holder admits the wrong grant.
- The verifier trusts one configured root AID (the test GLEIF root here); production would use GLEIF's
  root and the governed QVI list, and check ECR as well as OOR roles.
- Revocation after recording: the verifier (or anyone watching KERI) should call
  `recordOwnerAssurance(credentialId, NONE, 0)` when the role credential is revoked; removing a verifier
  voids all its results on-chain.
- Design reference: the call sequence follows the public signify-ts integration tests
  (WebOfTrust/signify-ts, Apache-2.0); the code in `verifier/` is written for this project.
