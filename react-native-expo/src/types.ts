export interface Verification {
  name: 'phone_verified' | 'kyc_verified' | 'id_document_verified';
  status: 'not_started' | 'pending' | 'rejected' | 'verified';
  errors: string[];
}

export interface CryptoCustomer {
  id: string;
  provided_fields: string[];
  verifications: Verification[];
}

export interface ConsumerWallet {
  id: string;
  livemode: boolean;
  network: string;
  wallet_address: string;
}

export interface PaymentTokenCard {
  brand?: string;
  last4?: string;
  exp_month?: number;
  exp_year?: number;
  funding: string;
}

export interface PaymentToken {
  id: string;
  type: 'card' | 'us_bank_account';
  card?: PaymentTokenCard;
}

export type RootStackParamList = {
  Home: undefined;
  /** Demo configuration: KYC tier and limit source. */
  Settings: undefined;
  Auth: undefined;
  Register: { email: string; authToken: string };
  KYCPrimer: { customerId: string; authToken: string };
  KYC: { customerId: string; authToken: string };
  Address: {
    customerId: string;
    authToken: string;
    firstName: string;
    lastName: string;
    /** Present for L1/L2 only — L0 skips SSN collection. */
    idNumber?: string;
    /** Present for L1/L2 only — L0 skips DOB collection. */
    dobDay?: number;
    dobMonth?: number;
    dobYear?: number;
  };
  Wallet: {
    customerId: string;
    authToken: string;
    /**
     * Passed from AddressScreen during initial KYC onboarding so WalletScreen
     * knows which verification tier to wait for after the wallet is attached.
     * Omitted when coming from other flows (e.g. wallet management).
     */
    kycTier?: 'L0' | 'L1' | 'L2';
  };
  PaymentMethod: {
    customerId: string;
    authToken: string;
    walletAddress: string;
    network: string;
  };
  /**
   * KYC step-up screen. Shown when session creation returns a KYC error.
   * Collects only the incremental fields the user hasn't yet provided, based
   * on the Stripe error code and their current verification status:
   *
   *   missing_identity_verification  + currentTier=L0 → collect SSN + DOB → attachKycInfo
   *   missing_document_verification  + currentTier=L0 → collect SSN + DOB → attachKycInfo → verifyIdentity
   *   missing_document_verification  + currentTier=L1 → verifyIdentity only
   *
   * After the SDK calls succeed, navigates to VerificationPending to wait
   * for Stripe's async review before retrying the session.
   */
  KYCStepUp: {
    customerId: string;
    authToken: string;
    /** Stripe error code from the failed session creation. */
    errorCode:
      | 'crypto_onramp_missing_minimum_identity_verification'
      | 'crypto_onramp_missing_identity_verification'
      | 'crypto_onramp_missing_document_verification';
    /**
     * Customer's current KYC tier, derived from kyc_tiers via deriveCurrentTier().
     * Using kyc_tiers (not verifications) is authoritative — kyc_verified can
     * be non-not_started for L0 users, making verifications unreliable.
     */
    currentTier: 'L0' | 'L1' | 'L2';
    // Original payment details — used to retry session creation after step-up.
    walletAddress: string;
    network: string;
    sourceAmount: string;
    sourceCurrency: string;
    destinationCurrency: string;
    paymentToken: string;
    paymentLabel: string;
  };
  /**
   * VerificationPendingScreen polls getCryptoCustomer() until the required
   * verification leaves the `pending` state, then continues the user's flow.
   *
   * This screen is reused for two distinct flows:
   *
   *   Flow A — Initial KYC onboarding (destination = 'PaymentMethod')
   *     Reached from WalletScreen after the user attaches a wallet.
   *     AddressScreen → WalletScreen → VerificationPendingScreen → PaymentMethodScreen
   *     Set `tier` and `requiredVerification` so the screen knows what to watch.
   *     `walletAddress` and `network` are required to navigate to PaymentMethod.
   *     Session payment params (sourceAmount, paymentToken, etc.) are NOT needed.
   *
   *   Flow B — Payment step-up (destination omitted)
   *     Reached from KYCStepUpScreen after the user provides extra identity
   *     info to unlock a higher transaction limit. Once verified, this screen
   *     automatically creates the onramp session and sends the user to checkout.
   *     All payment params are required so the session can be created.
   *
   * See VerificationPendingScreen.tsx for the full flow diagram.
   */
  VerificationPending: {
    customerId: string;
    authToken: string;
    /** Which verification to watch. Determines which status field to poll. */
    requiredVerification: 'kyc_verified' | 'id_document_verified';
    /**
     * The customer's KYC tier (L0 / L1 / L2), used for the badge label.
     * Flow A passes it from WalletScreen; Flow B derives it from requiredVerification.
     */
    tier?: 'L0' | 'L1' | 'L2';
    /**
     * Flow A only. Navigates to PaymentMethodScreen once verification passes.
     * When omitted (Flow B), the screen creates an onramp session instead.
     */
    destination?: 'PaymentMethod';
    // Required for both flows: walletAddress + network are needed to navigate
    // to PaymentMethod (Flow A) or to create a session (Flow B).
    walletAddress?: string;
    network?: string;
    // Flow B only — needed to create the onramp session.
    sourceAmount?: string;
    sourceCurrency?: string;
    destinationCurrency?: string;
    paymentToken?: string;
    paymentLabel?: string;
  };
  Checkout: {
    customerId: string;
    authToken: string;
    walletAddress: string;
    network: string;
    sessionId: string;
    sourceAmount: string;
    sourceCurrency: string;
    destinationCurrency: string;
    paymentLabel: string;
  };
  Success: {
    transactionId?: string;
    destinationAmount?: string;
    destinationCurrency?: string;
  };
};
