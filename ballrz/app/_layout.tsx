import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { AuthProvider } from '@/hooks/useAuth';
import { colors } from '@/lib/theme';

export default function RootLayout() {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="auth" options={{ presentation: 'modal', title: 'Join Ballrz' }} />
        <Stack.Screen name="upload" options={{ title: 'Post a highlight' }} />
        <Stack.Screen name="challenge" options={{ title: 'Weekly Challenge' }} />
        <Stack.Screen name="profile/[id]" options={{ title: 'Profile' }} />
      </Stack>
    </AuthProvider>
  );
}
