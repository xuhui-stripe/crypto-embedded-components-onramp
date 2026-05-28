/**
 * VerificationPendingScreen — waits for Stripe's async identity review to
 * complete before retrying onramp session creation.
 *
 * Both L1 (attachKycInfo) and L2 (verifyIdentity) verifications are processed
 * asynchronously by Stripe. Creating a session while verification is still
 * `pending` returns a 400 error, so we must poll until the status resolves.
 *
 * Polling strategy:
 *   - Call getCryptoCustomer every POLL_INTERVAL_MS.
 *   - Stop when the required verification is no longer `pending`:
 *       verified → proceed to create session and navigate to Checkout.
 *       rejected → show error, allow the user to go back.
 *   - Stop after MAX_POLLS attempts and show a timeout message.
 *
 * Merchant integration note:
 *   Always poll before retrying session creation — never assume a verification
 *   is complete just because the SDK call returned without an error.
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
import { getCryptoCustomer, createOnrampSession, KycTierEntry } from '../api/client';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'VerificationPending'>;
  route: RouteProp<RootStackParamList, 'VerificationPending'>;
};

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40; // 2 minutes

type PollStatus = 'polling' | 'verified' | 'rejected' | 'timeout' | 'creating_session';

export default function VerificationPendingScreen({ navigation, route }: Props) {
  const {
    customerId, authToken, requiredVerification,
    walletAddress, network, sourceAmount, sourceCurrency,
    destinationCurrency, paymentToken, paymentLabel,
  } = route.params;

  const [status, setStatus] = useState<PollStatus>('polling');
  const [pollCount, setPollCount] = useState(0);
  const [verificationStatus, setVerificationStatus] = useState<string>('pending');
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

  // Start polling on mount.
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
        // Transient error — keep polling.
        scheduleNext(attempt);
        return;
      }

      const currentStatus =
        requiredVerification === 'id_document_verified'
          ? result.data.idDocStatus
          : result.data.kycStatus;

      setVerificationStatus(currentStatus);
      setKycTiers(result.data.kycTiers ?? []);
      setPollCount(attempt + 1);

      if (currentStatus === 'verified') {
        setStatus('verified');
        await createSessionAndProceed();
      } else if (currentStatus === 'rejected') {
        setStatus('rejected');
      } else {
        // still pending — keep polling
        scheduleNext(attempt);
      }
    } catch {
      if (mountedRef.current) scheduleNext(attempt);
    }
  };

  const scheduleNext = (attempt: number) => {
    pollRef.current = setTimeout(() => poll(attempt + 1), POLL_INTERVAL_MS);
  };

  const createSessionAndProceed = async () => {
    setStatus('creating_session');
    try {
      const sessionResult = await createOnrampSession({
        paymentToken,
        walletAddress,
        customerId,
        authToken,
        destinationNetwork: network,
        sourceAmount: parseFloat(sourceAmount),
        sourceCurrency,
        destinationCurrency,
      });

      if (!mountedRef.current) return;

      if (!sessionResult.success) {
        Alert.alert(
          'Session Error',
          sessionResult.error.message,
          [{ text: 'Go Back', onPress: () => navigation.navigate('PaymentMethod', { customerId, authToken, walletAddress, network }) }],
        );
        return;
      }

      navigation.replace('Checkout', {
        customerId, authToken, walletAddress, network,
        sessionId: sessionResult.data.id,
        sourceAmount, sourceCurrency, destinationCurrency, paymentLabel,
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

  const tierLabel = requiredVerification === 'id_document_verified' ? 'L2' : 'L1';
  const verificationLabel =
    requiredVerification === 'id_document_verified'
      ? 'ID document & selfie'
      : 'SSN & date of birth';

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------

  if (status === 'rejected') {
    return (
      <View style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.iconText}>✗</Text>
          <Text style={styles.title}>Verification Failed</Text>
          <Text style={styles.subtitle}>
            Your {verificationLabel} verification was not approved. Please
            check the information you provided and try again.
          </Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => navigation.navigate('PaymentMethod', { customerId, authToken, walletAddress, network })}
          >
            <Text style={styles.buttonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (status === 'timeout') {
    return (
      <View style={styles.container}>
        <View style={styles.content}>
          <Text style={styles.iconText}>⏱</Text>
          <Text style={styles.title}>Taking Longer Than Expected</Text>
          <Text style={styles.subtitle}>
            Stripe's review is still in progress. You can try your purchase
            again in a few minutes.
          </Text>
          <TouchableOpacity
            style={styles.button}
            onPress={() => navigation.navigate('PaymentMethod', { customerId, authToken, walletAddress, network })}
          >
            <Text style={styles.buttonText}>Return to Payment</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // polling or creating_session
  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <ActivityIndicator color="#635BFF" size="large" style={{ marginBottom: 24 }} />

        <Text style={styles.tierBadge}>Awaiting {tierLabel} verification</Text>
        <Text style={styles.title}>Verification In Progress</Text>
        <Text style={styles.subtitle}>
          {status === 'creating_session'
            ? 'Verification complete! Creating your transaction...'
            : `Stripe is reviewing your ${verificationLabel}. This usually takes a few seconds.`}
        </Text>

        <View style={styles.statusCard}>
          {kycTiers.length > 0 ? (
            kycTiers.map((tier) => (
              <View key={tier.tier}>
                <View style={styles.statusRow}>
                  <Text style={styles.statusLabel}>{tier.tier.toUpperCase()} status</Text>
                  <Text style={[styles.statusValue, statusStyle(tier.verification_status)]}>
                    {tier.verification_status}
                  </Text>
                </View>
                {tier.verification_errors && tier.verification_errors.length > 0 && (
                  <View style={styles.errorBlock}>
                    {tier.verification_errors.map((err, i) => (
                      <Text key={i} style={styles.errorText}>• {err}</Text>
                    ))}
                  </View>
                )}
              </View>
            ))
          ) : (
            <View style={styles.statusRow}>
              <Text style={styles.statusLabel}>Status</Text>
              <Text style={[styles.statusValue, styles.statusPending]}>
                {verificationStatus}
              </Text>
            </View>
          )}
          <View style={[styles.statusRow, { borderBottomWidth: 0 }]}>
            <Text style={styles.statusLabel}>Checks completed</Text>
            <Text style={styles.statusValue}>{pollCount}</Text>
          </View>
        </View>

        <Text style={styles.hint}>
          Polling{' '}
          <Text style={styles.hintMono}>getCryptoCustomer()</Text>
          {' '}every {POLL_INTERVAL_MS / 1000}s until status is{' '}
          <Text style={styles.hintMono}>verified</Text>
        </Text>
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
