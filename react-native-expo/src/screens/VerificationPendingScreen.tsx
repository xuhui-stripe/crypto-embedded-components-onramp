/**
 * VerificationPendingScreen — polls Stripe until an async identity review
 * resolves, then continues the user's flow.
 *
 * ─── Why this screen exists ────────────────────────────────────────────────
 * Stripe processes KYC asynchronously. After your app calls attachKycInfo()
 * or verifyIdentity(), the verification status stays `pending` for some time
 * before moving to `verified` or `rejected`. Any attempt to create an onramp
 * session while status is still `pending` returns a 400 error.
 *
 * This screen bridges that gap: it polls getCryptoCustomer() on a timer and
 * advances the user as soon as the status resolves — or shows the failure
 * details inline if the verification is rejected.
 *
 * ─── Two flows that share this screen ──────────────────────────────────────
 *
 * Flow A — Initial KYC onboarding (destination = 'PaymentMethod')
 *   The user just completed KYC (AddressScreen) and attached a wallet
 *   (WalletScreen). Before allowing them to enter payment details, we gate
 *   on Stripe's async review of the KYC submission.
 *
 *   AddressScreen
 *     → attachKycInfo()            ← L0 / L1: name + address (+ SSN for L1)
 *     → verifyIdentity()           ← L2 only: document + selfie
 *     → WalletScreen               ← attach wallet
 *     → VerificationPendingScreen  ← wait here
 *     → PaymentMethodScreen        ← proceed once verified
 *
 *   Route params: destination='PaymentMethod', tier, requiredVerification,
 *                 walletAddress, network
 *   On verified  → navigation.replace('PaymentMethod')
 *   On rejected  → stay on screen; show which tier failed; prompt to go back
 *
 * Flow B — Payment step-up (destination omitted)
 *   The user tried to start a purchase but Stripe returned a KYC error
 *   because their current tier's limit was too low. KYCStepUpScreen collected
 *   the extra identity info; now we wait for Stripe to review it before
 *   retrying the session.
 *
 *   PaymentMethodScreen
 *     → createOnrampSession() returns KYC error
 *     → KYCStepUpScreen
 *     → attachKycInfo() / verifyIdentity()
 *     → VerificationPendingScreen  ← wait here
 *     → CheckoutScreen             ← session created automatically on verified
 *
 *   Route params: destination omitted, all payment params required
 *   On verified  → createOnrampSession() → navigation.replace('Checkout')
 *   On rejected  → stay on screen; show which tier failed; prompt to go back
 *
 * ─── Polling strategy ───────────────────────────────────────────────────────
 *   - Call getCryptoCustomer() every POLL_INTERVAL_MS.
 *   - Derive the current tier via deriveCurrentTier(kycTiers).
 *   - Stop when that tier's verification_status is no longer `pending`.
 *   - Stop after MAX_POLLS attempts (≈ 2 minutes) and show a timeout message.
 *
 * Merchant note: always poll before retrying session creation — never assume
 * a verification is complete just because the SDK call returned without error.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../types';
import { getCryptoCustomer, createOnrampSession, KycTierEntry, deriveCurrentTier } from '../api/client';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'VerificationPending'>;
  route: RouteProp<RootStackParamList, 'VerificationPending'>;
};

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40; // ~2 minutes

type PollStatus = 'polling' | 'verified' | 'rejected' | 'timeout' | 'creating_session';

export default function VerificationPendingScreen({ navigation, route }: Props) {
  const {
    customerId, authToken, requiredVerification,
    // destination controls which flow we're in (see file header):
    //   'PaymentMethod' → Flow A: initial onboarding, go to PaymentMethod on success
    //   undefined       → Flow B: payment step-up, create session on success
    destination,
    // tier is the customer's KYC tier, used for the badge label.
    // Flow A passes it explicitly from WalletScreen.
    // Flow B omits it and the label is derived from requiredVerification.
    tier,
    walletAddress, network,
    // Payment params — Flow B only (session creation).
    sourceAmount, sourceCurrency, destinationCurrency, paymentToken, paymentLabel,
  } = route.params;

  const [status, setStatus] = useState<PollStatus>('polling');
  const [pollCount, setPollCount] = useState(0);
  const [kycTiers, setKycTiers] = useState<KycTierEntry[]>([]);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  useEffect(() => {
    poll(0);
  }, []);

  const poll = async (attempt: number) => {
    if (!mountedRef.current) return;

    if (attempt >= MAX_POLLS) {
      setStatus('timeout');
      return;
    }

    try {
      const result = await getCryptoCustomer(customerId, authToken);
      if (!mountedRef.current) return;

      if (!result.success) {
        // Transient network error — keep polling.
        scheduleNext(attempt);
        return;
      }

      // Derive the customer's current KYC tier from the kycTiers array, then
      // read that tier's verification_status. This is the correct approach:
      // after the user submits KYC info, deriveCurrentTier returns the tier
      // they just attempted (e.g. L1 after attachKycInfo, L2 after verifyIdentity),
      // and we check whether Stripe has finished reviewing it.
      const kycTiersData = result.data.kycTiers ?? [];
      const currentTierKey = deriveCurrentTier(kycTiersData).toLowerCase() as 'l0' | 'l1' | 'l2';
      const tierEntry = kycTiersData.find(k => k.tier === currentTierKey);
      const currentStatus = tierEntry?.verification_status ?? 'pending';

      setKycTiers(kycTiersData);
      setPollCount(attempt + 1);

      if (currentStatus === 'verified') {
        setStatus('verified');
        if (destination === 'PaymentMethod') {
          // Flow A: KYC onboarding verified — proceed to add a payment method.
          navigation.replace('PaymentMethod', {
            customerId, authToken,
            walletAddress: walletAddress!,
            network: network!,
          });
        } else {
          // Flow B: Step-up verified — retry session creation and go to checkout.
          await createSessionAndProceed();
        }
      } else if (currentStatus === 'rejected') {
        setStatus('rejected');
      } else {
        // Still pending — check again after the interval.
        scheduleNext(attempt);
      }
    } catch {
      if (mountedRef.current) scheduleNext(attempt);
    }
  };

  const scheduleNext = (attempt: number) => {
    pollRef.current = setTimeout(() => poll(attempt + 1), POLL_INTERVAL_MS);
  };

  // Flow B only: create the onramp session now that verification passed,
  // then send the user straight to checkout.
  const createSessionAndProceed = async () => {
    setStatus('creating_session');
    try {
      const sessionResult = await createOnrampSession({
        paymentToken: paymentToken!,
        walletAddress: walletAddress!,
        customerId,
        authToken,
        destinationNetwork: network!,
        sourceAmount: parseFloat(sourceAmount!),
        sourceCurrency: sourceCurrency!,
        destinationCurrency: destinationCurrency!,
      });

      if (!mountedRef.current) return;

      if (!sessionResult.success) {
        Alert.alert(
          'Session Error',
          sessionResult.error.message,
          [{ text: 'Go Back', onPress: () => navigation.navigate('PaymentMethod', { customerId, authToken, walletAddress: walletAddress!, network: network! }) }],
        );
        return;
      }

      navigation.replace('Checkout', {
        customerId, authToken,
        walletAddress: walletAddress!, network: network!,
        sessionId: sessionResult.data.id,
        sourceAmount: sourceAmount!, sourceCurrency: sourceCurrency!,
        destinationCurrency: destinationCurrency!, paymentLabel: paymentLabel!,
      });
    } catch (err: any) {
      if (mountedRef.current) {
        Alert.alert('Error', err.message);
      }
    }
  };

  const statusStyle = (s: string) => {
    if (s === 'verified') return styles.statusVerified;
    if (s === 'rejected') return styles.statusRejected;
    if (s === 'pending') return styles.statusPending;
    return styles.statusMuted;
  };

  const tierLabel = tier ?? (requiredVerification === 'id_document_verified' ? 'L2' : 'L1');
  const verificationLabel =
    requiredVerification === 'id_document_verified'
      ? 'ID document & selfie'
      : 'SSN & date of birth';

  const isPolling = status === 'polling';
  const isCreatingSession = status === 'creating_session';
  const isActive = isPolling || isCreatingSession;
  const isRejected = status === 'rejected';
  const isTimeout = status === 'timeout';

  const handleGoBack = () => {
    if (destination === 'PaymentMethod') {
      // Flow A: restart KYC from the beginning.
      navigation.navigate('KYCPrimer', { customerId, authToken });
    } else {
      // Flow B: go back to payment method selection.
      navigation.navigate('PaymentMethod', { customerId, authToken, walletAddress: walletAddress!, network: network! });
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>

        {/* Icon / spinner */}
        {isActive
          ? <ActivityIndicator color="#635BFF" size="large" style={{ marginBottom: 24 }} />
          : <Text style={[styles.iconText, isRejected ? styles.iconRejected : styles.iconTimeout]}>
              {isRejected ? '✗' : '⏱'}
            </Text>
        }

        {/* Tier badge */}
        {isPolling && (
          <Text style={styles.tierBadge}>Awaiting {tierLabel} verification</Text>
        )}
        {isCreatingSession && (
          <Text style={styles.tierBadgeSuccess}>Verification Complete</Text>
        )}

        {/* Title */}
        <Text style={styles.title}>
          {isRejected ? 'Verification Failed'
            : isTimeout ? 'Taking Longer Than Expected'
            : isCreatingSession ? 'Creating Transaction'
            : 'Verification In Progress'}
        </Text>

        {/* Subtitle */}
        <Text style={styles.subtitle}>
          {isRejected
            ? 'One or more verifications were not approved. Please go back and re-enter your information.'
            : isTimeout
            ? "Stripe's review is still in progress. You can try again in a few minutes."
            : isCreatingSession
            ? 'Your identity was verified. Creating your onramp session now...'
            : `Stripe is reviewing your ${verificationLabel}. This usually takes a few seconds.`}
        </Text>

        {/* Per-tier status card — shown while polling or after rejection */}
        {!isTimeout && (
          <View style={styles.statusCard}>
            {kycTiers.length > 0 ? (
              kycTiers.map((kycTier) => (
                <View key={kycTier.tier}>
                  <View style={styles.statusRow}>
                    <Text style={styles.statusLabel}>{kycTier.tier.toUpperCase()} status</Text>
                    <Text style={[styles.statusValue, statusStyle(kycTier.verification_status)]}>
                      {kycTier.verification_status}
                    </Text>
                  </View>
                  {kycTier.verification_errors && kycTier.verification_errors.length > 0 && (
                    <View style={styles.errorBlock}>
                      {kycTier.verification_errors.map((err, i) => (
                        <Text key={i} style={styles.errorText}>• {err}</Text>
                      ))}
                    </View>
                  )}
                </View>
              ))
            ) : (
              <View style={styles.statusRow}>
                <Text style={styles.statusLabel}>Status</Text>
                <Text style={[styles.statusValue, styles.statusPending]}>pending</Text>
              </View>
            )}
            {isActive && (
              <View style={[styles.statusRow, { borderBottomWidth: 0 }]}>
                <Text style={styles.statusLabel}>Checks completed</Text>
                <Text style={styles.statusValue}>{pollCount}</Text>
              </View>
            )}
          </View>
        )}

        {/* Polling hint */}
        {isPolling && (
          <Text style={styles.hint}>
            Polling{' '}
            <Text style={styles.hintMono}>getCryptoCustomer()</Text>
            {' '}every {POLL_INTERVAL_MS / 1000}s until status is{' '}
            <Text style={styles.hintMono}>verified</Text>
          </Text>
        )}

        {/* Go back button — shown after rejection or timeout */}
        {(isRejected || isTimeout) && (
          <TouchableOpacity style={styles.button} onPress={handleGoBack}>
            <Text style={styles.buttonText}>
              {isTimeout ? 'Return to Payment' : 'Go Back & Re-enter'}
            </Text>
          </TouchableOpacity>
        )}

      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', justifyContent: 'center' },
  content: { paddingHorizontal: 32, alignItems: 'center' },

  iconText: { fontSize: 48, marginBottom: 16 },
  iconRejected: { color: '#ef4444' },
  iconTimeout: { color: '#f0a500' },

  tierBadge: {
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#635BFF',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
    color: '#635BFF',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 14,
  },
  tierBadgeSuccess: {
    backgroundColor: '#0d2818',
    borderWidth: 1,
    borderColor: '#22c55e',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
    color: '#22c55e',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 14,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 10,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    lineHeight: 20,
    marginBottom: 28,
    textAlign: 'center',
  },

  statusCard: {
    backgroundColor: '#111',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#1e1e1e',
    width: '100%',
    marginBottom: 20,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1e1e1e',
  },
  statusLabel: { color: '#555', fontSize: 13 },
  statusValue: { color: '#888', fontSize: 13, fontWeight: '500' },
  statusPending: { color: '#f0a500' },
  statusVerified: { color: '#22c55e' },
  statusRejected: { color: '#ef4444' },
  statusMuted: { color: '#555' },
  errorBlock: { paddingBottom: 8, paddingLeft: 4 },
  errorText: { color: '#ef4444', fontSize: 12, lineHeight: 18 },

  hint: { color: '#444', fontSize: 12, textAlign: 'center', lineHeight: 18 },
  hintMono: { fontFamily: 'monospace', color: '#555' },

  button: {
    backgroundColor: '#635BFF',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
