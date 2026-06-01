/**
 * KYCStepUpScreen — collect only the incremental identity information needed
 * to satisfy the Stripe error returned when creating an onramp session.
 *
 * Three error codes drive three distinct UI paths:
 *
 *   missing_identity_verification + currentTier=L0
 *     → L0 already provided: name + address
 *     → Collect now: SSN + date of birth
 *     → SDK call: attachKycInfo({ idNumber, dateOfBirth })
 *     → Navigate: goBack() to PaymentMethodScreen to retry session
 *
 *   missing_document_verification + currentTier=L0
 *     → L0 already provided: name + address
 *     → Collect now: SSN + date of birth, then launch verifyIdentity()
 *     → SDK calls: attachKycInfo({ idNumber, dateOfBirth }) → verifyIdentity()
 *     → Navigate: goBack() to PaymentMethodScreen to retry session
 *
 *   missing_document_verification + currentTier=L1
 *     → L1 already provided: name + SSN + DOB + address
 *     → Collect now: government ID + selfie via verifyIdentity()
 *     → SDK call: verifyIdentity()
 *     → Navigate: goBack() to PaymentMethodScreen to retry session
 *
 * Merchant integration notes:
 *   - attachKycInfo() merges fields — only send the NEW fields for this step-up.
 *   - verifyIdentity() launches Stripe's built-in document-capture UI.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
  TextInput,
} from 'react-native';
import { useOnramp } from '../hooks/useOnramp';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'KYCStepUp'>;
  route: RouteProp<RootStackParamList, 'KYCStepUp'>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the customer's current KYC tier from the verification statuses
 * returned by getCryptoCustomer.
 *
 * "Current tier" = the highest tier that has been attempted (pending,
 * rejected, or verified). A tier is not_started until the user submits data.
 */
function getCurrentTier(kycStatus: string, idDocStatus: string): 'L0' | 'L1' | 'L2' {
  const attempted = ['pending', 'rejected', 'verified'];
  if (attempted.includes(idDocStatus)) return 'L2';
  if (attempted.includes(kycStatus)) return 'L1';
  return 'L0';
}

type StepUpPath =
  | 'collect_ssn_dob'          // L0 → L1: attach SSN + DOB
  | 'collect_ssn_dob_then_doc' // L0 → L2: attach SSN + DOB, then verifyIdentity
  | 'verify_identity';         // L1/L2 → L2: verifyIdentity only

function getStepUpPath(
  errorCode: string,
  currentTier: 'L0' | 'L1' | 'L2',
): StepUpPath {
  if (errorCode === 'crypto_onramp_missing_identity_verification') {
    return 'collect_ssn_dob';
  }
  // missing_document_verification
  if (currentTier === 'L0') return 'collect_ssn_dob_then_doc';
  return 'verify_identity';
}

function formatSSN(raw: string): string {
  if (raw.length <= 3) return raw;
  if (raw.length <= 5) return `${raw.slice(0, 3)}-${raw.slice(3)}`;
  return `${raw.slice(0, 3)}-${raw.slice(3, 5)}-${raw.slice(5)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function KYCStepUpScreen({ navigation, route }: Props) {
  const {
    customerId, authToken, errorCode, kycStatus, idDocStatus,
    walletAddress, network, sourceAmount, sourceCurrency,
    destinationCurrency, paymentToken, paymentLabel,
  } = route.params;

  const { attachKycInfo, verifyIdentity } = useOnramp();
  const [submitting, setSubmitting] = useState(false);

  const currentTier = getCurrentTier(kycStatus, idDocStatus);
  const path = getStepUpPath(errorCode, currentTier);

  // SSN + DOB fields — only used for collect_ssn_dob and collect_ssn_dob_then_doc
  const [ssnRaw, setSsnRaw] = useState('');
  const [ssnFocused, setSsnFocused] = useState(false);
  const [dobMonth, setDobMonth] = useState('');
  const [dobDay, setDobDay] = useState('');
  const [dobYear, setDobYear] = useState('');

  const ssnDisplay = ssnFocused
    ? formatSSN(ssnRaw)
    : ssnRaw.length === 9 ? `•••-••-${ssnRaw.slice(5)}` : formatSSN(ssnRaw);

  const handleSubmit = async () => {
    if (path !== 'verify_identity') {
      if (ssnRaw.length !== 9 || !dobDay || !dobMonth || !dobYear) {
        Alert.alert('Missing Information', 'Please fill in your SSN and full date of birth.');
        return;
      }
    }

    setSubmitting(true);
    try {
      if (path === 'collect_ssn_dob' || path === 'collect_ssn_dob_then_doc') {
        // Attach the missing sensitive fields. attachKycInfo merges with the
        // name + address already on file from the user's L0 session.
        const kycResult = await attachKycInfo({
          idNumber: ssnRaw,
          dateOfBirth: {
            day: parseInt(dobDay, 10),
            month: parseInt(dobMonth, 10),
            year: parseInt(dobYear, 10),
          },
        });
        if (kycResult?.error) {
          Alert.alert('Verification Error', kycResult.error.message);
          return;
        }
      }

      if (path === 'collect_ssn_dob_then_doc' || path === 'verify_identity') {
        // Launch Stripe's document-capture UI for L2 verification.
        // Reference: https://docs.stripe.com/crypto/onramp/kyc-integration-guide#use-verifyidentity-for-l2-kyc
        const idResult = await verifyIdentity();
        if (idResult?.error) {
          console.log('[KYCStepUp] verifyIdentity note:', idResult.error.message);
        }
        navigation.goBack();
      } else {
        navigation.goBack();
      }
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render — verify identity only (L1 → L2)
  // ---------------------------------------------------------------------------

  if (path === 'verify_identity') {
    return (
      <View style={styles.container}>
        <View style={styles.simpleContent}>
          <Text style={styles.tierBadge}>{currentTier} → L2</Text>
          <Text style={styles.title}>Identity Document Required</Text>
          <Text style={styles.subtitle}>
            This transaction requires L2 verification. Please photograph your
            government-issued ID and take a selfie to continue.
          </Text>

          <View style={styles.infoCard}>
            <Text style={styles.infoCardTitle}>What you will need</Text>
            {[
              "Government-issued photo ID (passport or driver's license)",
              'A selfie to match your ID photo',
            ].map(item => (
              <View key={item} style={styles.bulletRow}>
                <Text style={styles.bullet}>•</Text>
                <Text style={styles.bulletText}>{item}</Text>
              </View>
            ))}
          </View>

          <View style={styles.infoCard}>
            <Text style={styles.infoCardTitle}>SDK call</Text>
            <Text style={styles.infoCardBody}>
              <Text style={styles.infoCode}>verifyIdentity()</Text>
              {' '}— opens Stripe's guided capture flow. Verification is
              asynchronous; you'll see a status screen while Stripe reviews
              your documents.
            </Text>
          </View>
        </View>

        <View style={styles.simpleFooter}>
          <TouchableOpacity
            style={[styles.button, submitting && styles.buttonDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.buttonText}>Start Identity Verification</Text>}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — SSN + DOB form (L0 → L1 or L0 → L2)
  // ---------------------------------------------------------------------------

  const targetTier = path === 'collect_ssn_dob_then_doc' ? 'L2' : 'L1';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.tierBadge}>{currentTier} → {targetTier}</Text>
      <Text style={styles.title}>
        {targetTier === 'L2' ? 'Upgrade to L2 Verification' : 'Upgrade to L1 Verification'}
      </Text>
      <Text style={styles.subtitle}>
        This transaction requires additional identity verification. Since you
        already provided your name and address, we only need the fields below.
      </Text>

      <View style={styles.infoCard}>
        <Text style={styles.infoCardTitle}>Incremental verification</Text>
        <Text style={styles.infoCardBody}>
          SDK call: <Text style={styles.infoCode}>attachKycInfo{'({ idNumber, dateOfBirth })'}</Text>
          {path === 'collect_ssn_dob_then_doc'
            ? <Text>{'\n'}Followed by: <Text style={styles.infoCode}>verifyIdentity()</Text></Text>
            : null}
        </Text>
      </View>

      <Text style={styles.fieldLabel}>Social Security Number</Text>
      <TextInput
        style={styles.input}
        value={ssnDisplay}
        onChangeText={t => setSsnRaw(t.replace(/\D/g, '').slice(0, 9))}
        onFocus={() => setSsnFocused(true)}
        onBlur={() => setSsnFocused(false)}
        placeholder="XXX-XX-XXXX"
        placeholderTextColor="#555"
        keyboardType="numeric"
        maxLength={11}
      />

      <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Date of Birth</Text>
      <View style={styles.dobRow}>
        <DobField label="MM" value={dobMonth} onChange={setDobMonth} maxLength={2} />
        <DobField label="DD" value={dobDay} onChange={setDobDay} maxLength={2} />
        <DobField label="YYYY" value={dobYear} onChange={setDobYear} maxLength={4} />
      </View>

      {path === 'collect_ssn_dob_then_doc' && (
        <View style={[styles.infoCard, { marginTop: 4 }]}>
          <Text style={styles.infoCardTitle}>Next step</Text>
          <Text style={styles.infoCardBody}>
            After submitting your SSN and date of birth, Stripe's
            identity-verification flow will launch to capture your government
            ID and selfie. Both steps happen in the same session.
          </Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.button, submitting && styles.buttonDisabled]}
        onPress={handleSubmit}
        disabled={submitting}
      >
        {submitting
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>
              {path === 'collect_ssn_dob_then_doc'
                ? 'Continue to Identity Verification'
                : 'Verify & Continue'}
            </Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DobField({
  label, value, onChange, maxLength,
}: { label: string; value: string; onChange: (v: string) => void; maxLength?: number }) {
  return (
    <View style={{ flex: 1, marginHorizontal: 4 }}>
      <Text style={styles.dobLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholder={label}
        placeholderTextColor="#555"
        keyboardType="numeric"
        maxLength={maxLength}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  simpleContent: { flex: 1, paddingHorizontal: 24, paddingTop: 32 },
  simpleFooter: { paddingHorizontal: 24, paddingBottom: 40 },
  scrollContent: { paddingHorizontal: 24, paddingTop: 32, paddingBottom: 48 },

  tierBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#1a1a2e',
    borderWidth: 1,
    borderColor: '#635BFF',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
    color: '#635BFF',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 12,
  },
  title: { fontSize: 24, fontWeight: '700', color: '#fff', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#888', lineHeight: 20, marginBottom: 20 },

  infoCard: {
    backgroundColor: '#141414',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#222',
  },
  infoCardTitle: {
    color: '#635BFF',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  infoCardBody: { color: '#777', fontSize: 13, lineHeight: 18 },
  infoCode: { fontFamily: 'monospace', color: '#aaa', fontSize: 12 },

  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  bullet: { color: '#888', fontSize: 14, marginRight: 8, lineHeight: 20 },
  bulletText: { color: '#ccc', fontSize: 14, lineHeight: 20, flex: 1 },

  fieldLabel: {
    color: '#635BFF',
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  input: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    color: '#fff',
    fontSize: 15,
    marginBottom: 4,
  },
  dobRow: { flexDirection: 'row', marginBottom: 20, marginHorizontal: -4 },
  dobLabel: { color: '#aaa', fontSize: 13, marginBottom: 6 },

  button: {
    backgroundColor: '#635BFF',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
