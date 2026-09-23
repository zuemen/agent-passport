# vLEI owner verification — setup notes

Status: **researched, not yet run** (2026-09-23). Scheduled for 10/7–10/10; if the chain below does not
run end to end within two days it moves to the roadmap.

## What we verify (off-chain)
```
GLEIF root (test) → QVI → Legal Entity vLEI → OOR/ECR Auth → OOR or ECR role credential → holder AID
                                                                                   │
                            holder AID signs keccak256(credentialId) ─────────────┘
```
If the chain is valid, unrevoked, and the role holder signed this Agent Passport credential's id, the
verifier service calls `CredentialStatusRegistry.recordOwnerAssurance(credentialId, VLEI_VERIFIED,
keccak256(roleCredentialSAID))`. KERI/ACDC stays off-chain; only the result goes on-chain.

All identities are **local test identities**. No real LEI and no real company names are used.

## Environment (from signify-ts `main`)
| Piece | Source |
|---|---|
| `signify-ts` | npm `signify-ts` 0.4.0 (repo `main` is 0.4.1, unreleased) — https://github.com/WebOfTrust/signify-ts |
| Test vLEI chain script | `test-integration/singlesig-vlei-issuance.test.ts` (run with `vitest -c vitest.integration.ts`) |
| docker-compose | repo root `docker-compose.yaml` (+ `config/keria.json`, `config/witness-demo`) |
| Services | `keria` = `weboftrust/keria:0.4.0` (3901 admin, 3902 http, 3903 boot) · `witness-demo` = `weboftrust/keri:1.2.13` (5642–5644) · `vlei-server` = `gleif/vlei:1.0.3` (7723) |

Schema SAIDs used by that script:

| Credential | SAID |
|---|---|
| QVI | `EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao` |
| Legal Entity | `ENPXp1vQzRF6JwIuS-mp2U8Uf1MoADoP_GqQ62VsDZWY` |
| OOR Auth | `EKA57bKBKxr_kN7iN5i7lMUxpMG-s19dRcmov1iDxz-E` |
| OOR | `EBNaNu-M9P5cgrnfl2Fvymy4E_jvxxyjb70PRtiANlJy` |
| ECR Auth | `EH6ekLjSr8V32WyFbGe1zXjTzFs9PkTYmupJ9H65O14g` |
| ECR | `EEy9PkikFcANV1l7EHukCeXqrzT1hNZjGlUk7wuMO5jw` |

## Signing and verifying arbitrary data
- Holder: `const hab = await client.identifiers().get(name); const sigs = await client.manager!.get(hab).sign(bytes, false);`
- Verifier: current key from `client.keyStates().get(pre)` (`k[0]`), then `new Verfer({ qb64: k0 }).verify(sigRaw, bytes)`;
  check the role credential's issuee equals that AID and walk its edges (`client.credentials().list()`).

## Minimal path
1. Clone signify-ts, `npm ci`.
2. `docker compose up -d --wait`.
3. Run `singlesig-vlei-issuance.test.ts` to create the test chain.
4. Add: role AID signs `keccak256(credentialId)`; verify via key state + issuee + edges.
5. Extract into `verifier/` (Node) that submits `recordOwnerAssurance` with the verifier key.

## Known risks
- npm 0.4.0 vs repo 0.4.1 API drift → run against the repo's code.
- Windows: use local URLs (`http://localhost:7723`), not docker-internal hostnames, or OOBI resolution fails.
- Witness/KERIA receipts can time out → keep the repo's retry helper.
- signify-ts has no one-call chain verifier (revocation state, edges, schema rules). `gleif/vlei-verifier`
  is a candidate to evaluate.
