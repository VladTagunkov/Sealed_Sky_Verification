/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NAMESTONE_API_KEY?: string;
  readonly VITE_NAMESTONE_DOMAIN?: string;
  /** POST target for USB SignInference proxy (default http://localhost:3000/sign-inference) */
  readonly VITE_SIGN_INFERENCE_URL?: string;
  /** POST target for verify + on-chain submit (default http://localhost:3000/submit) */
  readonly VITE_SUBMIT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
