import { ModelManager } from '../speech/model-manager'
import { openNodeSpeechDownloadRequest } from '../speech/node-speech-download-request'
import { canReadOpenAiSpeechApiKey } from '../speech/openai-api-key-store'
import type { SpeechServiceFactories } from '../speech/speech-runtime-service'
import { SttService } from '../speech/stt-service'

/**
 * quirkyd's speech (#31174): cloud models with a key this host can read, on-device models when
 * `quirky serve` hands it the installed app's recognizer. Models land in this profile's `speech-models`, as on Electron serve.
 */
export const quirkydSpeechServiceFactories: SpeechServiceFactories = {
  createModelManager: (customModelsDir) =>
    // No keychain here to prompt, so readiness can prove the key decrypts.
    new ModelManager(customModelsDir, openNodeSpeechDownloadRequest, canReadOpenAiSpeechApiKey),
  createSttService: (models) => new SttService(models)
}
