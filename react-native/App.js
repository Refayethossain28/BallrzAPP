import React, { useEffect, useRef, useState } from 'react';
import { StatusBar, SafeAreaView, StyleSheet, Platform, Linking, BackHandler } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';

const CITY_URLS = {
  london: 'https://refayethossain28.github.io/BallrzAPP/apexvip-client.html',
  dubai: 'https://refayethossain28.github.io/BallrzAPP/apexvip-dubai.html',
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export default function App() {
  const webviewRef = useRef(null);
  const [city] = useState('london'); // TODO: detect from device locale/IP

  useEffect(() => {
    (async () => {
      // Request location permission
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const loc = await Location.getCurrentPositionAsync({});
        webviewRef.current?.injectJavaScript(`
          if (window.onNativeLocation) window.onNativeLocation(${loc.coords.latitude}, ${loc.coords.longitude});
        `);
      }
      // Request notification permission
      await Notifications.requestPermissionsAsync();
    })();

    // Android back button support
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      webviewRef.current?.goBack();
      return true;
    });
    return () => backHandler.remove();
  }, []);

  const onMessage = (event) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'OPEN_URL') Linking.openURL(msg.url);
      if (msg.type === 'SWITCH_CITY') {
        // City switching handled via URL change
      }
    } catch(e) {}
  };

  // Inject bridge for native capabilities
  const injectedJS = `
    window.isNativeApp = true;
    window.nativePlatform = '${Platform.OS}';
    window.postNativeMessage = function(msg) {
      window.ReactNativeWebView?.postMessage(JSON.stringify(msg));
    };
    true;
  `;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <WebView
        ref={webviewRef}
        source={{ uri: CITY_URLS[city] }}
        style={styles.webview}
        injectedJavaScriptBeforeContentLoaded={injectedJS}
        onMessage={onMessage}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        geolocationEnabled={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        allowsBackForwardNavigationGestures={Platform.OS === 'ios'}
        pullToRefreshEnabled={false}
        overScrollMode="never"
        bounces={false}
        startInLoadingState={true}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  webview: { flex: 1, backgroundColor: '#000000' },
});
