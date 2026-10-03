/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** ElevenLabs Agent ID for Firefly (public agent; see src/firefly/AGENT.md). */
  readonly VITE_ELEVENLABS_AGENT_ID?: string;
}
