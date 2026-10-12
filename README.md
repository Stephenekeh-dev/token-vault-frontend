# 🔐 Token Vault — Angular Frontend

> A wallet-connected web interface for the [Token Vault Solana program](../token-vault). Connect Solflare or Phantom, pick an SPL token, and deposit into or withdraw from a vault that only the on-chain program can release.

![Angular](https://img.shields.io/badge/Angular-19-DD0031?style=flat-square&logo=angular)
![Solana](https://img.shields.io/badge/Solana-Devnet-9945FF?style=flat-square&logo=solana)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript)
![Status](https://img.shields.io/badge/status-working%20on%20devnet-14F195?style=flat-square)

---

## ✨ Features

- **Wallet connection** — auto-detects Solflare, falls back to Phantom
- **Live balances** — SOL balance, token balance in your wallet, and token balance in the vault
- **Three vault actions** — create vault (one-time), deposit, withdraw
- **Readable errors** — real program errors from transaction simulation, not generic wallet messages
- **Self-healing transactions** — retries automatically if the blockhash expires while you approve
- **Explorer links** — every transaction and on-chain account links to Solana Explorer

## 🏗️ Architecture

The app is deliberately small and split into two layers: a **service** that owns everything blockchain-related, and a **component** that owns everything the user sees.

```
┌──────────────────────────────────────────────────────────────┐
│                         Browser                              │
│                                                              │
│  ┌────────────────────┐        ┌───────────────────────────┐ │
│  │   AppComponent     │ calls  │    TokenVaultService      │ │
│  │                    │───────▶│                           │ │
│  │  • UI state        │        │  • wallet detection       │ │
│  │  • busy / errors   │◀───────│  • PDA derivation         │ │
│  │  • user input      │returns │  • instruction building   │ │
│  └────────────────────┘        │  • send + retry + confirm │ │
│                                └─────┬───────────┬─────────┘ │
│                                      │           │           │
│                        sign          │           │ read/send │
│                          ▼           │           ▼           │
│                  ┌──────────────┐    │    ┌────────────────┐ │
│                  │ Solflare /   │    │    │ Solana Devnet  │ │
│                  │ Phantom      │    │    │ RPC            │ │
│                  └──────────────┘    │    └───────┬────────┘ │
│                                      ▼            │          │
│                              ┌──────────────┐     │          │
│                              │ token_vault  │     │          │
│                              │ .json (IDL)  │     │          │
│                              └──────────────┘     │          │
└───────────────────────────────────────────────────┼──────────┘
                                                    ▼
                                      ┌──────────────────────────┐
                                      │   token_vault program    │
                                      │   (Anchor, on devnet)    │
                                      └──────────────────────────┘
```

### Responsibilities

| Layer | File | Owns |
|---|---|---|
| View | `app.component.html` / `.css` | Layout, styling, what shows when |
| Controller | `app.component.ts` | UI state, button handlers, friendly error text |
| Blockchain logic | `services/token-vault.service.ts` | Everything that touches the wallet or the network |
| Contract interface | `idl/token_vault.json` | Program address and instruction discriminators, copied from the Anchor build |

Keeping blockchain logic out of the component means the UI can be redesigned, or ported to another framework, without touching transaction code.

## 🔄 Data flow

### Deposit, step by step

```
1. User types an amount and clicks Deposit
2. Component calls service.deposit(mint, amount)
3. Service reads the mint's decimals, converts "1.5" → base units (1500000)
4. Service derives addresses:
     vault authority PDA  = findProgramAddress(["vault-authority", owner, mint])
     vault token account  = ATA(mint, vault authority PDA)
     user token account   = ATA(mint, owner)
5. Service builds the instruction:
     data = discriminator (from IDL) + amount as u64 little-endian
6. Fetch a fresh blockhash → ask the wallet to sign
7. Send with preflight simulation ON → poll until confirmed
8. If the blockhash expired during approval → go to 6 (up to 4 attempts)
9. Component refreshes balances and shows the explorer link
```

### Why transactions are sent this way

Wallet popups take seconds, and a Solana blockhash only stays valid for roughly a minute. The service therefore:

- fetches the blockhash **immediately before** asking for a signature
- keeps **preflight simulation on**, so a failing transaction reports the real program error at once
- polls signature status instead of racing the blockhash expiry
- **retries** with a fresh blockhash when expiry is the cause

## 🎨 Design

A dark, Solana-branded interface built around one idea: **a three-step flow where each card appears only when the previous step is done.**

### Flow

```
 ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
 │ 1  Wallet     │ ──▶ │ 2  Token      │ ──▶ │ 3  Your vault │
 │ connect       │     │ paste a mint  │     │ create /      │
 │               │     │ and Load      │     │ deposit /     │
 │               │     │               │     │ withdraw      │
 └───────────────┘     └───────────────┘     └───────────────┘
```

Progressive disclosure keeps the screen to one decision at a time, so a first-time user is never shown a Withdraw button before a vault exists.

### Design tokens

| Token | Value | Used for |
|---|---|---|
| Background | `#0d0b1a` with a purple radial glow | Page |
| Solana purple | `#9945ff` | Step badges, focus rings, secondary buttons |
| Solana green | `#14f195` | Primary gradient, success, vault highlight |
| Surface | `rgba(255,255,255,0.05)` + blur | Cards |
| Error | `#ff5a5a` | Error banner |
| Type | System UI stack, monospace for addresses | All text |

### UX decisions

- **One status area** at the bottom handles busy, error and success states, so feedback is always in the same place.
- **Controls disable while busy**, which prevents double-submitted transactions.
- **Wallet cancellations** are shown as "You cancelled the request", not as a failure.
- **Vault highlighted in green** so the number that matters stands out.
- **Advanced details collapsed**: PDA and token-account addresses sit behind a disclosure for people who want to verify on-chain.

## 📁 Project structure

```
token-vault-frontend/
├── src/
│   ├── app/
│   │   ├── services/
│   │   │   └── token-vault.service.ts   # wallet, PDAs, instructions, sending
│   │   ├── app.component.ts             # UI state and handlers
│   │   ├── app.component.html           # template
│   │   └── app.component.css            # theme
│   ├── idl/
│   │   └── token_vault.json             # copied from the Anchor build
│   └── polyfills.ts                     # Buffer + global for @solana/web3.js
├── angular.json
└── tsconfig.app.json
```

## 🚀 Getting started

### Prerequisites

- Node.js 18+
- [Solflare](https://solflare.com) or [Phantom](https://phantom.app), set to **Devnet**
- Some devnet SOL, from [faucet.solana.com](https://faucet.solana.com)
- A devnet SPL token mint with a balance in your wallet

### Install and run

```bash
git clone <your-frontend-repo-url>
cd token-vault-frontend
npm install
ng serve
```

Open `http://localhost:4200`.

### Keep the IDL in sync

If you change the Anchor program and rebuild it, copy the fresh IDL across:

```bash
cp ../token-vault/target/idl/token_vault.json src/idl/token_vault.json
```

### Get a test token

The Anchor project includes a script that creates a devnet token and mints 100 to your wallet:

```bash
cd ../token-vault
node setup-test-token.js <YOUR_WALLET_ADDRESS>
```

It prints a **mint address**. Paste that into the app's Token card.

## ⚙️ Setup notes (things that bite on Angular + Solana)

- **Buffer polyfill.** `@solana/web3.js` expects Node's `Buffer`. `src/polyfills.ts` must be listed in **both** `angular.json` (`polyfills`) and `tsconfig.app.json` (`files`), or signing fails in confusing ways.
- **JSON imports.** `resolveJsonModule` must be enabled in `tsconfig.json` so the IDL can be imported.
- **Wallet detection.** Solflare injects `window.solflare`, Phantom injects `window.solana`. Solflare's `connect()` also doesn't return the public key the way Phantom's does, so the service reads `provider.publicKey` as a fallback.
- **Unrecognized-program warnings.** Wallets warn on any custom program they haven't seen before. That is expected on devnet.

## ⚠️ Known limitations

- Devnet only. The RPC URL is the public endpoint, which is rate limited; swap in a Helius or QuickNode URL in `TokenVaultService` for heavier use.
- One vault per (wallet, token) pair, by design of the program.
- No token picker. Users paste a mint address.
- No automated frontend tests yet. The on-chain logic is covered by the program's integration suite.

## 🗺️ Roadmap

- [x] Wallet connection (Solflare / Phantom)
- [x] Create vault, deposit, withdraw
- [x] Live balances and explorer links
- [ ] Deploy to Vercel / Netlify
- [ ] Token picker from the wallet's own token accounts
- [ ] Transaction history panel
- [ ] Display vault events once the program emits them

## 📄 License

MIT

## 👤 Author

Built by Stephen as part of a hands-on Solana portfolio series.