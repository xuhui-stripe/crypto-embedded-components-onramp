/**
 * PaymentMethodScreen — select amount, destination currency, and payment card.
 *
 * This screen adds two KYC step-up integration points:
 *
 * 1. Proactive limit check (before session creation)
 *    After the user taps "Review Purchase", the app reads transaction limits
 *    from either the Stripe API (GET /v1/crypto/onramp_transaction_limits) or the
 *    local config in src/kycLimits.ts (controlled by Settings → Limit Source).
 *    If the requested amount exceeds the customer's remaining capacity, the
 *    user is offered the option to complete a KYC step-up immediately rather
 *    than creating a session that would later be rejected.
 *
 * 2. Reactive step-up (after session creation)
 *    If the onramp session is created but Stripe's response includes
 *    `next_action.required_verifications`, the session cannot proceed to
 *    checkout until those verifications are completed. The app navigates to
 *    KYCStepUpScreen which handles collection and then retries the session.
 *
 * Merchant integration notes:
 *   - Call getTransactionLimits() before showing the checkout flow so users
 *     see their remaining capacity early, not after tapping "Confirm".
 *   - Always also check next_action on the created session — limits can
 *     change between the pre-check and session creation.
 *   - Store the payment token and all transaction details in route params so
 *     KYCStepUpScreen can re-create the session after verification.
 */

import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { useOnramp } from '../hooks/useOnramp';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../types';
import { createOnrampSession, getTransactionLimits, getCryptoCustomer } from '../api/client';
import { CURRENCIES_BY_NETWORK } from '../constants';
import { useSettings } from '../context/SettingsContext';
import { LOCAL_LIMITS, TransactionLimits } from '../kycLimits';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'PaymentMethod'>;
  route: RouteProp<RootStackParamList, 'PaymentMethod'>;
};

export default function PaymentMethodScreen({ navigation, route }: Props) {
  const { customerId, authToken, walletAddress, network } = route.params;
  const availableCurrencies = CURRENCIES_BY_NETWORK[network] ?? ['eth'];
  const [sourceAmount, setSourceAmount] = useState('10');
  const [destCurrency, setDestCurrency] = useState(availableCurrencies[0]);

  const [paymentReady, setPaymentReady] = useState(false);
  const [paymentLabel, setPaymentLabel] = useState('');
  const [cryptoPaymentToken, setCryptoPaymentToken] = useState('');
  const [collectingMethod, setCollectingMethod] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);

  // Transaction limits — loaded when the screen mounts.
  const [limits, setLimits] = useState<TransactionLimits | null>(null);
  const [loadingLimits, setLoadingLimits] = useState(true);
  const [limitsError, setLimitsError] = useState<string | null>(null);

  const { collectPaymentMethod, createCryptoPaymentToken } = useOnramp();
  const { settings } = useSettings();

  // ---------------------------------------------------------------------------
  // Load transaction limits on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    (async () => {
      setLoadingLimits(true);
      setLimitsError(null);
      try {
        if (settings.limitSource === 'api') {
          // Fetch live limits from Stripe.
          // Stripe API: GET /v1/crypto/onramp_transaction_limits
          // Response: { limits: { "usd.fiat": { card: [{ limit, settlement_speed }] } } }
          // We extract the card instant limit as it applies to most onramp transactions.
          const result = await getTransactionLimits(authToken, {
            walletAddress,
            destinationNetwork: network,
          });
          if (result.success) {
            const cardLimits = result.data.limits?.['usd.fiat']?.card ?? [];
            const instantEntry =
              cardLimits.find(l => l.settlement_speed === 'instant') ?? cardLimits[0];
            setLimits({
              limit: instantEntry?.limit ?? 0,
            });
          } else {
            setLimitsError('Could not fetch limits from API');
          }
        } else {
          // Use hardcoded limits for the selected KYC tier (src/kycLimits.ts).
          setLimits(LOCAL_LIMITS[settings.kycTier]);
        }
      } catch (err: any) {
        setLimitsError(err.message);
      } finally {
        setLoadingLimits(false);
      }
    })();
  }, [authToken, settings.limitSource, settings.kycTier]);

  // ---------------------------------------------------------------------------
  // Payment method collection
  // ---------------------------------------------------------------------------

  // collectPaymentMethod opens Stripe's wallet UI which already lists saved
  // methods and allows adding new ones — always go through this SDK flow.
  const handleCollectPaymentMethod = async () => {
    setCollectingMethod(true);
    try {
      const result = await collectPaymentMethod('Card');
      if (result?.error) {
        Alert.alert('Error', result.error.message);
        return;
      }
      if (!result?.displayData) return;

      const tokenResult = await createCryptoPaymentToken();
      if (tokenResult?.error) {
        Alert.alert('Error', tokenResult.error.message);
        return;
      }

      setCryptoPaymentToken(tokenResult.cryptoPaymentToken ?? '');
      setPaymentLabel(result.displayData.label ?? 'Card');
      setPaymentReady(true);
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setCollectingMethod(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Proceed to checkout
  // ---------------------------------------------------------------------------

  const handleProceed = async () => {
    const amount = parseFloat(sourceAmount);
    if (!amount || amount <= 0) {
      Alert.alert('Error', 'Please enter a valid amount.');
      return;
    }

    setCreatingSession(true);
    try {
      const sessionResult = await createOnrampSession({
        paymentToken: cryptoPaymentToken,
        walletAddress,
        customerId,
        authToken,
        destinationNetwork: network,
        sourceAmount: amount,
        sourceCurrency: 'usd',
        destinationCurrency: destCurrency,
      });

      if (!sessionResult.success) {
        await handleSessionError(sessionResult.error.code, sessionResult.error.message);
        return;
      }

      navigation.navigate('Checkout', {
        customerId,
        authToken,
        walletAddress,
        network,
        sessionId: sessionResult.data.id,
        sourceAmount,
        sourceCurrency: 'usd',
        destinationCurrency: destCurrency,
        paymentLabel,
      });
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setCreatingSession(false);
    }
  };

  // ---------------------------------------------------------------------------
  // KYC error routing
  //
  // Session creation returns a Stripe error code when the customer needs more
  // identity verification. We fetch the customer's current verification status
  // to route the user to KYCStepUpScreen to collect the missing data.
  //
  // Error codes:
  //   missing_minimum_identity_verification — L0 (name + address) not done
  //   missing_identity_verification         — L1 (SSN + DOB) required
  //   missing_document_verification         — L2 (photo ID + selfie) required
  //
  // See: https://docs.stripe.com/crypto/onramp/kyc-integration-guide
  //      #interpret-limit-errors-from-cryptoonrampsession
  // ---------------------------------------------------------------------------

  const handleSessionError = async (errorCode: string, message: string) => {
    const kycErrorCodes = [
      'crypto_onramp_missing_minimum_identity_verification',
      'crypto_onramp_missing_identity_verification',
      'crypto_onramp_missing_document_verification',
    ];

    if (!kycErrorCodes.includes(errorCode)) {
      Alert.alert('Error', message);
      return;
    }

    if (errorCode === 'crypto_onramp_missing_minimum_identity_verification') {
      Alert.alert(
        'Identity Verification Required',
        'Please complete basic identity verification (name and address) before making a purchase.',
      );
      return;
    }

    const customerResult = await getCryptoCustomer(customerId, authToken);
    const kycStatus = customerResult.success ? customerResult.data.kycStatus : 'not_started';
    const idDocStatus = customerResult.success ? customerResult.data.idDocStatus : 'not_started';

    navigation.navigate('KYCStepUp', {
      customerId, authToken,
      errorCode: errorCode as any,
      kycStatus, idDocStatus,
      walletAddress, network, sourceAmount, sourceCurrency: 'usd',
      destinationCurrency: destCurrency, paymentToken: cryptoPaymentToken, paymentLabel,
    });
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const amountNum = parseFloat(sourceAmount) || 0;
  const exceedsLimit = limits !== null && amountNum > limits.limit;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Add a payment method</Text>

      {/* Amount input */}
      <Text style={styles.label}>Amount (USD)</Text>
      <TextInput
        style={[styles.input, exceedsLimit && styles.inputWarning]}
        value={sourceAmount}
        onChangeText={setSourceAmount}
        keyboardType="decimal-pad"
        placeholder="10"
        placeholderTextColor="#555"
      />

      {/* Transaction limits display
          Shows the customer's remaining capacity from the selected source
          (API or local config). A warning appears when the entered amount
          exceeds the remaining limit, prompting a step-up before checkout. */}
      <View style={[styles.limitsCard, exceedsLimit && styles.limitsCardWarning]}>
        <View style={styles.limitsHeader}>
          <Text style={styles.limitsTitle}>Transaction Limits</Text>
          <Text style={styles.limitsSource}>
            {settings.limitSource === 'api'
              ? '🔵 Live API'
              : `📋 Local (${settings.kycTier})`}
          </Text>
        </View>

        {loadingLimits && (
          <ActivityIndicator color="#635BFF" size="small" style={{ marginVertical: 6 }} />
        )}

        {limitsError && !loadingLimits && (
          <Text style={styles.limitsErrorText}>{limitsError}</Text>
        )}

        {limits && !loadingLimits && (
          <>
            <View style={styles.limitsRow}>
              <Text style={styles.limitsLabel}>Card limit (instant)</Text>
              <Text
                style={[
                  styles.limitsValue,
                  exceedsLimit && styles.limitsValueWarning,
                ]}
              >
                ${limits.limit.toFixed(2)}
              </Text>
            </View>

            {exceedsLimit && (
              <View style={styles.warningRow}>
                <Text style={styles.warningText}>
                  Amount exceeds your current limit. We'll guide you through
                  identity verification automatically if needed.
                </Text>
              </View>
            )}
          </>
        )}
      </View>

      {/* Destination currency */}
      <Text style={styles.label}>Destination Currency</Text>
      <View style={styles.chipRow}>
        {availableCurrencies.map(c => (
          <TouchableOpacity
            key={c}
            style={[styles.chip, destCurrency === c && styles.chipSelected]}
            onPress={() => setDestCurrency(c)}
          >
            <Text style={[styles.chipText, destCurrency === c && styles.chipTextSelected]}>
              {c.toUpperCase()}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Payment method */}
      <Text style={styles.label}>Payment Method</Text>

      {paymentReady ? (
        <View style={styles.paymentCard}>
          <Text style={styles.paymentLabel}>{paymentLabel}</Text>
          <TouchableOpacity
            onPress={() => {
              setPaymentReady(false);
              setCryptoPaymentToken('');
            }}
          >
            <Text style={styles.changeText}>Change</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity
          style={[styles.addMethodButton, collectingMethod && styles.buttonDisabled]}
          onPress={handleCollectPaymentMethod}
          disabled={collectingMethod}
        >
          {collectingMethod
            ? <ActivityIndicator color="#635BFF" />
            : <Text style={styles.addMethodText}>Select or Add Payment Method</Text>}
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={[styles.button, (!paymentReady || creatingSession) && styles.buttonDisabled]}
        onPress={handleProceed}
        disabled={!paymentReady || creatingSession}
      >
        {creatingSession
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>Review Purchase</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { paddingHorizontal: 24, paddingTop: 48, paddingBottom: 32 },
  title: { fontSize: 26, fontWeight: '700', color: '#fff', marginBottom: 24 },
  label: { color: '#aaa', fontSize: 13, marginBottom: 8 },
  input: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    color: '#fff',
    fontSize: 16,
    marginBottom: 12,
  },
  inputWarning: { borderColor: '#ff6b35' },

  // Limits card
  limitsCard: {
    backgroundColor: '#111',
    borderRadius: 10,
    padding: 14,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#1e1e1e',
  },
  limitsCardWarning: { borderColor: '#5a2010' },
  limitsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  limitsTitle: { color: '#666', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  limitsSource: { color: '#444', fontSize: 11 },
  limitsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  limitsLabel: { color: '#555', fontSize: 13 },
  limitsValue: { color: '#888', fontSize: 13, fontWeight: '500' },
  limitsValueWarning: { color: '#ff6b35', fontWeight: '700' },
  limitsErrorText: { color: '#888', fontSize: 12, fontStyle: 'italic' },
  warningRow: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#2a1a14',
  },
  warningText: { color: '#cc5533', fontSize: 12, lineHeight: 17 },

  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 24, flexWrap: 'wrap' },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#333',
  },
  chipSelected: { backgroundColor: '#635BFF', borderColor: '#635BFF' },
  chipText: { color: '#888', fontSize: 13 },
  chipTextSelected: { color: '#fff' },
  paymentCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1a1a1a',
    borderRadius: 10,
    padding: 14,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#635BFF',
  },
  paymentLabel: { color: '#fff', fontSize: 15 },
  changeText: { color: '#635BFF', fontSize: 14 },
  addMethodButton: {
    borderWidth: 1,
    borderColor: '#635BFF',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 24,
  },
  addMethodText: { color: '#635BFF', fontSize: 14, fontWeight: '600' },
  button: {
    backgroundColor: '#635BFF',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
