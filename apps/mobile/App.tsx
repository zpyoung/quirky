import { SafeAreaProvider } from 'react-native-safe-area-context'
import { NativeApp } from './src/native/NativeApp'

export default function App() {
  return <SafeAreaProvider><NativeApp /></SafeAreaProvider>
}
