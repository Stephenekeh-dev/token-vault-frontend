import { Injectable } from '@angular/core';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint
} from '@solana/spl-token';
import { Buffer } from 'buffer';
import idl from '../../idl/token_vault.json';

interface WalletProvider {
  publicKey?: PublicKey;
  connect(): Promise<{ publicKey?: PublicKey } | void>;
  disconnect(): Promise<void>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
}

declare global {
  interface Window {
    solana?: WalletProvider;
    solflare?: WalletProvider;
  }
}

export interface VaultState {
  decimals: number;
  userBalance: string;
  vaultBalance: string;
  vaultExists: boolean;
  vaultAuthority: string;
  vaultTokenAccount: string;
  userTokenAccount: string;
}

@Injectable({ providedIn: 'root' })
export class TokenVaultService {

  readonly rpcUrl = 'https://api.devnet.solana.com';
  readonly connection = new Connection(this.rpcUrl, 'confirmed');
  readonly programId = new PublicKey((idl as any).address);

  walletPublicKey: PublicKey | null = null;

  /** Prefers Solflare, falls back to Phantom's window.solana. */
  get provider(): WalletProvider | null {
    return window.solflare ?? window.solana ?? null;
  }

  // ---------------------------------------------------------------- wallet

  async connectWallet(): Promise<string> {
    const provider = this.provider;
    if (!provider) {
      throw new Error('No wallet found. Please install Solflare or Phantom.');
    }

    const response = await provider.connect();

    // Phantom returns { publicKey }; Solflare sets provider.publicKey instead.
    const publicKey = (response && (response as any).publicKey) ?? provider.publicKey;
    if (!publicKey) {
      throw new Error('Wallet connected but no public key was returned.');
    }

    this.walletPublicKey = publicKey;
    return publicKey.toBase58();
  }

  async disconnectWallet(): Promise<void> {
    try {
      await this.provider?.disconnect();
    } finally {
      this.walletPublicKey = null;
    }
  }

  async getSolBalance(): Promise<number> {
    this.requireWallet();
    const lamports = await this.connection.getBalance(this.walletPublicKey!, 'confirmed');
    return lamports / 1_000_000_000;
  }

  // ------------------------------------------------------------- addresses

  private deriveAddresses(mint: PublicKey) {
    const owner = this.walletPublicKey!;

    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault-authority'), owner.toBuffer(), mint.toBuffer()],
      this.programId
    );

    // The vault token account is an ATA owned by the PDA (off-curve), hence `true`.
    const vaultTokenAccount = getAssociatedTokenAddressSync(mint, vaultAuthority, true);
    const userTokenAccount = getAssociatedTokenAddressSync(mint, owner);

    return { vaultAuthority, vaultTokenAccount, userTokenAccount };
  }

  // ----------------------------------------------------------------- state

  async getVaultState(mintAddress: string): Promise<VaultState> {
    this.requireWallet();
    const mint = this.parseMint(mintAddress);
    const { vaultAuthority, vaultTokenAccount, userTokenAccount } = this.deriveAddresses(mint);

    const mintInfo = await getMint(this.connection, mint);
    const decimals = mintInfo.decimals;

    const userBalance = await this.safeTokenBalance(userTokenAccount);
    const vaultBalance = await this.safeTokenBalance(vaultTokenAccount);
    const vaultExists = (await this.connection.getAccountInfo(vaultAuthority)) !== null;

    return {
      decimals,
      userBalance: this.fromBaseUnits(userBalance, decimals),
      vaultBalance: this.fromBaseUnits(vaultBalance, decimals),
      vaultExists,
      vaultAuthority: vaultAuthority.toBase58(),
      vaultTokenAccount: vaultTokenAccount.toBase58(),
      userTokenAccount: userTokenAccount.toBase58()
    };
  }

  // ----------------------------------------------------------- instructions

  async initializeVault(mintAddress: string): Promise<string> {
    this.requireWallet();
    const mint = this.parseMint(mintAddress);
    const { vaultAuthority, vaultTokenAccount } = this.deriveAddresses(mint);
    const owner = this.walletPublicKey!;

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: vaultAuthority, isSigner: false, isWritable: true },
        { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }
      ],
      data: this.discriminator('initialize_vault')
    });

    return this.sendInstruction(ix);
  }

  async deposit(mintAddress: string, amountUi: string): Promise<string> {
    return this.transferInstruction('deposit', mintAddress, amountUi);
  }

  async withdraw(mintAddress: string, amountUi: string): Promise<string> {
    return this.transferInstruction('withdraw', mintAddress, amountUi);
  }

  private async transferInstruction(
    name: 'deposit' | 'withdraw',
    mintAddress: string,
    amountUi: string
  ): Promise<string> {
    this.requireWallet();
    const mint = this.parseMint(mintAddress);
    const { vaultAuthority, vaultTokenAccount, userTokenAccount } = this.deriveAddresses(mint);
    const owner = this.walletPublicKey!;

    const mintInfo = await getMint(this.connection, mint);
    const amount = this.toBaseUnits(amountUi, mintInfo.decimals);
    if (amount <= BigInt(0)) {
      throw new Error('Enter an amount greater than zero.');
    }

    const amountBytes = Buffer.alloc(8);
new DataView(amountBytes.buffer, amountBytes.byteOffset, 8).setBigUint64(0, amount, true);

    // Account order matches the Deposit / Withdraw structs in lib.rs.
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: userTokenAccount, isSigner: false, isWritable: true },
        { pubkey: vaultTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
      ],
      data: Buffer.concat([this.discriminator(name), amountBytes])
    });

    return this.sendInstruction(ix);
  }

  // --------------------------------------------------------------- sending

  /**
   * Fresh blockhash per attempt, preflight ON so failures surface immediately
   * with real program logs, and retry if the blockhash expired while the user
   * was clicking through the wallet popup.
   */
  private async sendInstruction(ix: TransactionInstruction): Promise<string> {
    const provider = this.provider;
    if (!provider) throw new Error('No wallet found.');

    const MAX_ATTEMPTS = 4;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

        const tx = new Transaction().add(ix);
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.walletPublicKey!;

        const signed = await provider.signTransaction(tx);

        const signature = await this.connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed'
        });

        const confirmed = await this.pollSignatureStatus(signature, 30_000);
        if (!confirmed) {
          throw new Error('Blockhash not found or expired');
        }
        return signature;

      } catch (error: any) {
        const msg: string = error?.message || '';
        const expired =
          msg.includes('Blockhash not found') ||
          msg.includes('block height exceeded') ||
          msg.includes('expired');

        if (expired && attempt < MAX_ATTEMPTS) {
          console.warn(`Blockhash expired (attempt ${attempt}). Retrying...`);
          continue;
        }
        throw error;
      }
    }

    throw new Error('Transaction failed after multiple attempts.');
  }

  private async pollSignatureStatus(signature: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { value } = await this.connection.getSignatureStatuses([signature]);
      const status = value[0];
      if (status) {
        if (status.err) {
          throw new Error('Transaction failed on-chain: ' + JSON.stringify(status.err));
        }
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return true;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return false;
  }

  // --------------------------------------------------------------- helpers

  private requireWallet(): void {
    if (!this.walletPublicKey) throw new Error('Connect your wallet first.');
  }

  private parseMint(address: string): PublicKey {
    try {
      return new PublicKey(address.trim());
    } catch {
      throw new Error('That is not a valid token mint address.');
    }
  }

  private discriminator(name: string): Buffer {
    const ix = (idl as any).instructions.find((i: any) => i.name === name);
    if (!ix) throw new Error(`Instruction "${name}" was not found in token_vault.json`);
    return Buffer.from(ix.discriminator);
  }

  private async safeTokenBalance(address: PublicKey): Promise<bigint> {
    try {
      const account = await getAccount(this.connection, address);
      return account.amount;
    } catch {
      return BigInt(0); // account does not exist yet
    }
  }

  private toBaseUnits(amountUi: string, decimals: number): bigint {
    const clean = amountUi.trim();
    if (!/^\d*\.?\d*$/.test(clean) || clean === '' || clean === '.') {
      throw new Error('Enter a valid number.');
    }
    const [whole, frac = ''] = clean.split('.');
    const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
    return BigInt(whole || '0') * BigInt(10) ** BigInt(decimals) + BigInt(fracPadded || '0');
  }

  private fromBaseUnits(raw: bigint, decimals: number): string {
    if (decimals === 0) return raw.toString();
    const base = BigInt(10) ** BigInt(decimals);
    const whole = raw / base;
    const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  }

  getProgramId(): string {
    return this.programId.toBase58();
  }
}