import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert,
} from 'react-native';
import { useOnramp } from '../hooks/useOnramp';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { signup, login, createAuthIntent, saveUser, getCryptoCustomer, deriveCurrentTier } from '../api/client';
import { MERCHANT_DISPLAY_NAME } from '../constants';
import { useSettings } from '../context/SettingsContext';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'Auth'>;
};

export default function AuthScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMode, setLoadingMode] = useState<'signup' | 'login' | null>(null);

  const { configure, hasLinkAccount, authorize, verifyIdentity } = useOnramp();

  // Read the KYC tier chosen in the Settings screen so we can route the user
  // through the appropriate identity-collection steps (or skip them for L0).
  const { settings } = useSettings();

  const handleAuth = async (mode: 'signup' | 'login') => {
    if (!email.trim() || !password.trim()) {
      Alert.alert('Error', 'Please enter both email and password.');
      return;
    }
    setLoading(true);
    setLoadingMode(mode);

    try {
      // Step 1: Authenticate with backend
      const authRes = mode === 'signup'
        ? await signup(email.trim(), password)
        : await login(email.trim(), password);

      if (!authRes.success) {
        Alert.alert('Error', authRes.error.message);
        return;
      }
      let authToken = authRes.data.token;

      // Step 2: Configure the onramp SDK
      const configResult = await configure({
        merchantDisplayName: MERCHANT_DISPLAY_NAME,
        appearance: { style: 'AUTOMATIC' },
      });
      if (configResult.error) {
        Alert.alert('SDK Config Error', configResult.error.message);
        return;
      }

      // Step 3: Check for existing Link account
      const linkResult = await hasLinkAccount(email.trim());
      if (linkResult.error) {
        Alert.alert('Error', linkResult.error.message);
        return;
      }

      if (!linkResult.hasLinkAccount) {
        // Register new Link user — phone collected in next screen
        navigation.navigate('Register', { email: email.trim(), authToken });
        return;
      }

      // Step 4: Create auth intent via backend
      const intentResult = await createAuthIntent(authToken);
      if (!intentResult.success) {
        Alert.alert('Error', intentResult.error.message);
        return;
      }
      if (intentResult.data.token) authToken = intentResult.data.token;

      // Step 5: Authorize (presents Link consent/OTP screen)
      const authResult = await authorize(intentResult.data.authIntentId);
      if (authResult.error) {
        Alert.alert('Authorization Error', authResult.error.message);
        return;
      }
      if (authResult.status === 'Denied') {
        Alert.alert('Denied', 'You must consent to continue.');
        return;
      }
      if (authResult.status !== 'Consented' || !authResult.customerId) {
        Alert.alert('Canceled', 'Authorization was canceled.');
        return;
      }

      await saveUser(authResult.customerId, authToken);

      // Step 6: Route to KYC collection (or skip) based on the selected tier.
      //
      // If the customer already has verified KYC (returning user), we skip
      // the collection screens regardless of the tier setting.
      const customerRes = await getCryptoCustomer(authResult.customerId, authToken);

      if (customerRes.success) {
        // Derive kyc_level from kyc_tiers using the same logic as the server.
        const kycTiers = customerRes.data.kycTiers ?? [];
        const INACTIVE = new Set(['not_available', 'not_started']);
        const ATTEMPTED = new Set(['pending', 'rejected', 'verified']);
        const statusOf = (tier: string) =>
          kycTiers.find(t => t.tier === tier)?.verification_status ?? 'not_started';

        let kyc_level: string;
        if (kycTiers.some(t => t.verification_status === 'pending')) {
          kyc_level = 'PENDING';
        } else if (kycTiers.every(t => INACTIVE.has(t.verification_status))) {
          kyc_level = 'REQUIRES_KYC';
        } else {
          const currentTier = deriveCurrentTier(kycTiers);
          const currentStatus = statusOf(currentTier);
          if (currentStatus === 'verified') {
            kyc_level = currentTier === 'l2' ? 'L2' : currentTier === 'l1' ? 'L1' : 'L0';
          } else if (currentStatus === 'rejected') {
            kyc_level = 'REJECTED';
          } else {
            kyc_level = 'REQUIRES_KYC';
          }
        }

        if (kyc_level === 'L0' || kyc_level === 'L1' || kyc_level === 'L2') {
          // Already verified at some tier — go straight to the wallet screen.
          const idResult = await verifyIdentity();
          if (idResult?.error) {
            console.log('Identity verification note:', idResult.error.message);
          }
          navigation.navigate('Wallet', { customerId: authResult.customerId, authToken });
        } else if (kyc_level === 'PENDING') {
          // Verification submitted and under review — proceed to wallet.
          navigation.navigate('Wallet', { customerId: authResult.customerId, authToken });
        } else if (kyc_level === 'REJECTED') {
          // Prior KYC attempt was rejected — re-enter the collection flow.
          navigation.navigate('KYCPrimer', { customerId: authResult.customerId, authToken });
        } else {
          // REQUIRES_KYC: no active tier yet. Apply settings.kycTier.
          // If settings.kycTier is greater than the current tier (l0),
          // route through the KYC collection flow; otherwise skip it.
          if (settings.kycTier === 'L0') {
            navigation.navigate('Wallet', { customerId: authResult.customerId, authToken });
          } else {
            // L1 or L2: proceed through the standard KYC collection flow.
            navigation.navigate('KYCPrimer', { customerId: authResult.customerId, authToken });
          }
        }
      } else {
        // Could not fetch customer KYC state — fall back to settings-based routing.
        if (settings.kycTier === 'L0') {
          navigation.navigate('Wallet', { customerId: authResult.customerId, authToken });
        } else {
          navigation.navigate('KYCPrimer', { customerId: authResult.customerId, authToken });
        }
      }
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Something went wrong.');
    } finally {
      setLoading(false);
      setLoadingMode(null);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Get Started</Text>
      <Text style={styles.subtitle}>Sign in to buy crypto</Text>

      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        placeholderTextColor="#555"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
      />
      <Text style={styles.label}>Password</Text>
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="password"
        placeholderTextColor="#555"
        secureTextEntry
        autoCapitalize="none"
      />

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={() => handleAuth('signup')}
          disabled={loading}
        >
          {loading && loadingMode === 'signup'
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.buttonText}>Sign Up</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.buttonSecondary, loading && styles.buttonDisabled]}
          onPress={() => handleAuth('login')}
          disabled={loading}
        >
          {loading && loadingMode === 'login'
            ? <ActivityIndicator color="#635BFF" />
            : <Text style={styles.buttonTextSecondary}>Log In</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', paddingHorizontal: 24, paddingTop: 48 },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#888', marginBottom: 32 },
  label: { color: '#aaa', fontSize: 14, marginBottom: 8 },
  input: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#333',
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    color: '#fff',
    fontSize: 16,
    marginBottom: 20,
  },
  buttonRow: { flexDirection: 'row', gap: 12 },
  button: {
    flex: 1,
    backgroundColor: '#635BFF',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonSecondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#635BFF',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  buttonTextSecondary: { color: '#635BFF', fontSize: 16, fontWeight: '600' },
});
