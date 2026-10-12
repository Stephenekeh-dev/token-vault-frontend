import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TokenVaultService, VaultState } from './services/token-vault.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
  walletAddress: string | null = null;
  solBalance: number | null = null;

  mintAddress = '';
  amount = '';
  state: VaultState | null = null;

  busy = false;
  busyLabel = '';
  errorMessage: string | null = null;
  successMessage: string | null = null;
  lastSignature: string | null = null;

  constructor(private vault: TokenVaultService) {}

  get programId(): string {
    return this.vault.getProgramId();
  }

  get shortWallet(): string {
    return this.walletAddress
      ? this.walletAddress.slice(0, 4) + '...' + this.walletAddress.slice(-4)
      : '';
  }

  explorerTx(sig: string): string {
    return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  }

  explorerAddress(addr: string): string {
    return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
  }

  async connect() {
    await this.run('Connecting wallet...', async () => {
      this.walletAddress = await this.vault.connectWallet();
      this.solBalance = await this.vault.getSolBalance();
    });
  }

  async disconnect() {
    await this.vault.disconnectWallet();
    this.walletAddress = null;
    this.solBalance = null;
    this.state = null;
    this.clearMessages();
  }

  async loadVault() {
    await this.run('Loading vault...', async () => {
      this.state = await this.vault.getVaultState(this.mintAddress);
    });
  }

  async initializeVault() {
    await this.run('Creating your vault...', async () => {
      const sig = await this.vault.initializeVault(this.mintAddress);
      this.lastSignature = sig;
      this.successMessage = 'Vault created on-chain.';
      this.state = await this.vault.getVaultState(this.mintAddress);
      this.solBalance = await this.vault.getSolBalance();
    });
  }

  async deposit() {
    await this.run('Depositing...', async () => {
      const sig = await this.vault.deposit(this.mintAddress, this.amount);
      this.lastSignature = sig;
      this.successMessage = `Deposited ${this.amount} tokens into the vault.`;
      this.amount = '';
      this.state = await this.vault.getVaultState(this.mintAddress);
    });
  }

  async withdraw() {
    await this.run('Withdrawing...', async () => {
      const sig = await this.vault.withdraw(this.mintAddress, this.amount);
      this.lastSignature = sig;
      this.successMessage = `Withdrew ${this.amount} tokens from the vault.`;
      this.amount = '';
      this.state = await this.vault.getVaultState(this.mintAddress);
    });
  }

  // ----------------------------------------------------------------- utils

  private clearMessages() {
    this.errorMessage = null;
    this.successMessage = null;
    this.lastSignature = null;
  }

  /** Wraps every action with busy state and friendly error handling. */
  private async run(label: string, action: () => Promise<void>) {
    this.clearMessages();
    this.busy = true;
    this.busyLabel = label;
    try {
      await action();
    } catch (error: any) {
      console.error(error);
      const msg: string = error?.message || 'Something went wrong.';
      if (/reject|cancel/i.test(msg)) {
        this.errorMessage = 'You cancelled the request in your wallet.';
      } else {
        this.errorMessage = msg;
      }
    } finally {
      this.busy = false;
      this.busyLabel = '';
    }
  }
}