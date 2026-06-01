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
  Wallet: { customerId: string; authToken: string };
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
   * After the SDK calls succeed, navigates back (goBack) to allow the user to
   * retry the session.
   */
  KYCStepUp: {
    customerId: string;
    authToken: string;
    /** Stripe error code from the failed session creation. */
    errorCode:
      | 'crypto_onramp_missing_minimum_identity_verification'
      | 'crypto_onramp_missing_identity_verification'
      | 'crypto_onramp_missing_document_verification';
    /** kycStatus from getCryptoCustomer — used to determine the current tier. */
    kycStatus: string;
    /** idDocStatus from getCryptoCustomer — used to determine the current tier. */
    idDocStatus: string;
    // Original payment details — used to retry session creation after step-up.
    walletAddress: string;
    network: string;
    sourceAmount: string;
    sourceCurrency: string;
    destinationCurrency: string;
    paymentToken: string;
    paymentLabel: string;
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
